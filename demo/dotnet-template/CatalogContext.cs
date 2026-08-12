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
        b.Entity<Item>().HasOne(i => i.Category).WithMany(c => c.Items).HasForeignKey(i => i.CategoryId);

    }
}
