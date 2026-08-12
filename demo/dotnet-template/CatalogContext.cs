using Microsoft.EntityFrameworkCore;

namespace Catalog;

public class Category
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public bool IsDeleted { get; set; }
    public List<Item> Items { get; set; } = new();
}

public class Item
{
    public int Id { get; set; }
    public int CategoryId { get; set; }
    public Category? Category { get; set; }
    public string Label { get; set; } = "";
    public decimal Price { get; set; }
    public bool IsDeleted { get; set; }
}

public class CatalogContext : DbContext
{
    public DbSet<Category> Categories => Set<Category>();
    public DbSet<Item> Items => Set<Item>();

    public static string DbPath =>
        Path.Combine(AppContext.BaseDirectory, "catalog.db");

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlite($"Data Source={DbPath}");

    protected override void OnModelCreating(ModelBuilder b)
    {
        // Note what is NOT here: no HasQueryFilter on IsDeleted for either entity.
        //
        // Soft delete is therefore something every query has to remember by hand. Nothing fails when
        // you forget — the rows just come back — so a smoke test that returns results proves the
        // endpoint does not crash and proves nothing about whether it filtered.
        b.Entity<Item>().HasOne(i => i.Category).WithMany(c => c.Items).HasForeignKey(i => i.CategoryId);

        // Price is left at EF Core's default mapping for decimal on SQLite, which is a TEXT column.
        //
        // That used to be a trap worth recording: text sorts lexicographically, so ORDER BY Price put
        // "100.00" before "42.00". It is not a trap here, and the reason is worth keeping. EF Core 10
        // emits `ORDER BY "Price" COLLATE EF_DECIMAL`, a collation the provider registers precisely to
        // make this case sort numerically — checked by logging the generated SQL, after the first two
        // attempts to reproduce the old behaviour produced correct output and looked like a mistake in
        // the test rather than a fix in the library.
        //
        // Left as a comment rather than deleted, because it is a small instance of the problem this
        // whole project has no answer for: a note that was true, that the tooling has since made
        // false, and that nobody will ever hit again to correct.
    }
}
