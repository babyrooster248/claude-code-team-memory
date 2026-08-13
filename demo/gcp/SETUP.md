# Standing the knowledge host up on a GCP VM

Written while doing it, on an `e2e-micro` Always Free instance with **958 MB of RAM**, Ubuntu 22.04,
node 20 and Claude Code already logged in. Every step below was run and verified from a second
machine over the internet; the notes attached to each are the things that actually went wrong or
would have.

The shape it ends in:

```
member's machine ──HTTPS 443──► Caddy (on the VM) ──HTTP──► 127.0.0.1:8791  ingest.js --config
                                                            inbox/ and the artifact clone are local
```

## 1. Reserve the external IP before anything else

```bash
gcloud compute addresses create agent-knowledge-ip \
  --addresses <CURRENT-EXTERNAL-IP> --region <REGION>
```

An in-use ephemeral address is promoted in place, so nothing restarts and the IP does not change.

Do this **first**, not last. The hostname below embeds the IP, and `AGENT_KNOWLEDGE_INGEST` is
committed into every project's `.claude/settings.json` — so an address that changes on stop/start
silently breaks the pipeline for the whole team, and the symptom is every member's hook quietly
spooling. On a running instance GCP already bills the external IPv4, so reserving it adds no cost
while it stays attached. Release it if you delete the VM: an unattached reserved address does cost.

## 2. Open 80 and 443, scoped to a tag

```bash
gcloud compute firewall-rules create allow-agent-knowledge-web \
  --allow tcp:80,tcp:443 --target-tags agent-knowledge --source-ranges 0.0.0.0/0
gcloud compute instances add-tags <INSTANCE> --zone <ZONE> --tags agent-knowledge
```

A target tag rather than the whole network, so one VM gets web ports and the rest of the project does
not. Port 80 is needed as well as 443 — Let's Encrypt validates over HTTP-01.

## 3. The endpoint, as a user service

```bash
git clone https://github.com/babyrooster248/claude-code-team-memory.git
node claude-code-team-memory/aggregator/make-credential.js you@example.com     # once per member
cp claude-code-team-memory/aggregator/config.sample.json config.json           # then edit
chmod 600 config.json
cp claude-code-team-memory/demo/gcp/agent-knowledge-ingest.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now agent-knowledge-ingest
sudo loginctl enable-linger "$USER"
curl -s localhost:8791/health          # {"ok":true}
```

`bind` stays `127.0.0.1` in `config.json`. Two reasons, and the second is the one people miss: a
wrong firewall rule then cannot expose the node process at all, and a loopback bind means you never
have to pass `--behind-tls-proxy` — a flag that asserts something the endpoint cannot verify.

`make-credential.js` prints the token once and stores only a scrypt hash, so a stolen `config.json`
cannot be replayed. Keep the tokens in a `600` file and hand them out the way you would any other
credential. There is no recovery path: a lost token is reissued, not looked up.

**Restart after editing `members`.** The config is read once at startup, so adding or revoking a
member without a restart leaves the endpoint using the old list — and the symptom is a `401` that
makes no sense to the person holding a credential you can see in the file:

```bash
systemctl --user restart agent-knowledge-ingest
```

Lower the rate limits from the shipped defaults while you are in there. On a public endpoint the
pre-auth bucket is the only thing between a flood of bad credentials and scrypt exhausting a 1 GB box:
`authAttemptsPerHour: 200, authBurst: 30` is plenty for a team.

## 4. TLS, with no domain to buy

```bash
sudo cp claude-code-team-memory/demo/gcp/Caddyfile /etc/caddy/Caddyfile   # edit the hostname
sudo systemctl reload caddy
sudo journalctl -u caddy -n 20 --no-pager | grep -i certificate
```

`<IP-WITH-DASHES>.sslip.io` resolves to that IP, so the certificate is a real Let's Encrypt one. The
whole step took about twelve seconds.

**Do not reach for a self-signed certificate.** The hook and `curl` will refuse it, and the only way
to make them proceed is `NODE_TLS_REJECT_UNAUTHORIZED=0` — which disables verification for every
HTTPS connection the process makes, on a wire that carries the member credential in a reversible form
on every note. It also has to live in the hook's environment, which means a committed
`settings.json`, which means `git pull` distributes it to the whole team.

## 5. Verify from a different machine, not from the VM

```bash
H=https://<IP-WITH-DASHES>.sslip.io
curl -s -o /dev/null -w "%{http_code} tls=%{ssl_verify_result}\n" $H/health   # 200 tls=0
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "X-Project: <id>" --data x $H/note   # 401
curl -s -o /dev/null -w "%{http_code}\n" -m 6 http://<IP>:8791/health          # 000, unreachable
```

The last line is the one worth keeping in a runbook: it proves the node process is not exposed, only
the proxy. `tls=0` means the certificate verified without `-k`.

## 6. If the trigger is going to run aggregate

`aggregate.js` needs Claude Code logged in **as the user the service runs as**, because the trigger
spawns it from that service. It also needs a clone of the project holding `AGENTS.md`, named in the
project's `aggregate.repo`.

Two things to settle before switching `push: true` on:

- **Push access from the host.** `aggregate.js --commit` builds a branch and commits, and `--push`
  is what sends it to origin. Use a deploy key scoped to that one repository, not a personal
  credential. This project refuses git as the *transport* because that needs a credential on every
  member's laptop; a scoped key on a managed host is a different thing, and worth saying out loud
  before someone points at the apparent contradiction.
- **Opening the request, if you want that too.** A deploy key cannot do it: opening a pull request is
  a forge API call and a deploy key is a git credential. So it is a second, separate token — for
  GitHub, a fine-grained PAT limited to the one repository with *pull requests: read and write* — and
  it is handed to `prCommand`, the team's own command, rather than to anything in this codebase. The
  tool never learns what a forge is, which is why it works on a git host that has no web interface.

  ```json
  "prCommand": "GH_TOKEN=$(cat /home/you/.gh-token) /home/you/bin/gh pr create --repo you/project --base main --head BRANCH --fill"
  ```

  `BRANCH` is substituted. Read the token from a file inside the command rather than putting it in
  the service environment: rotating it is then writing a file, with no unit to edit and no
  `daemon-reload`. Absolute path to `gh`, because the unit sets an explicit `PATH` and `~/bin` is
  not on it.

  Omit `prCommand` entirely and nothing breaks — the run prints the compare URL that the push itself
  returned, and a person clicks it. What you must not do is leave it configured with a dead token:
  that is the one path nothing retries, because the branch reaches origin either way, so every later
  run correctly declines to open a request for one that was never opened. The run says so loudly; the
  point is that somebody has to read it.

  The proposal always goes on one branch, `agent-knowledge`, so there is at most one open request for
  the artifact. A run whose branch origin already has adds a commit to the request under review
  instead of opening a competing one — `git ls-remote` decides that, asked before the push, because
  afterwards the answer is always yes.
- **Version parity.** Every filter figure in `docs/findings.md` was measured on a particular Claude
  Code version, and §3 exists because a number without its version is a slogan. If the host runs an
  older build than the one the numbers came from, either upgrade it or re-measure on it.

## What 958 MB of RAM means in practice

`ingest.js` is a few tens of megabytes and Caddy about the same. The cost is `aggregate.js`, which
spawns `claude -p` once per vote per note and once more to merge — sequentially, so memory is fine,
but with only 2 GB of swap behind 1 GB of RAM the wall-clock is not. **Measure a real run on the host
before building a demo around how long it takes**, rather than assuming it matches a laptop.
