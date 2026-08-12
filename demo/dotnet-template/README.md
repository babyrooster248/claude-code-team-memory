# Catalog

Console tooling for the catalog service. .NET 10, EF Core 10, SQLite. No build step beyond
`dotnet build`, and no database server — the store is a file next to the binary.

## Commands

```
dotnet run -- migrate                    apply schema migrations
dotnet run -- seed                       load the starter catalog
dotnet run -- report                      list items with their category
dotnet run -- update <id> <label>         rename an item
```

Configuration is in `appsettings.json`.

## Notes

Migrations are applied in code (`Database.Migrate()`), so the `dotnet-ef` tool is only needed if you
are authoring a new migration, not to run the app.
