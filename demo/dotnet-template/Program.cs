using Catalog;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var cmd = args.Length > 0 ? args[0] : "help";

switch (cmd)
{
    case "migrate": Migrate(); break;
    case "seed": Seed(); break;
    case "report": Report(); break;
    case "update": Update(); break;
    default:
        Console.WriteLine("usage: dotnet run -- <migrate|seed|report|update <id> <label>>");
        return 1;
}
return 0;

void Migrate()
{
    using var db = new CatalogContext();
    db.Database.Migrate();
    Console.WriteLine($"migrated: {CatalogContext.DbPath}");
}

void Seed()
{
    using var db = new CatalogContext();
    try
    {
        if (db.Categories.Any())
        {
            Console.WriteLine("already seeded");
            return;
        }

        var apparel = new Category { Name = "Apparel" };
        var outerwear = new Category { Name = "Outerwear" };
        var retired = new Category { Name = "Retired lines", IsDeleted = true };
        db.AddRange(apparel, outerwear, retired);

        db.AddRange(
            new Item { Category = apparel, Label = "Plain tee", Price = 9.50m },
            new Item { Category = apparel, Label = "Linen shirt", Price = 42.00m },
            new Item { Category = apparel, Label = "Sample run tee", Price = 10.00m, IsDeleted = true },
            new Item { Category = outerwear, Label = "Denim jacket", Price = 100.00m },
            new Item { Category = outerwear, Label = "Rain shell", Price = 129.99m },
            new Item { Category = retired, Label = "Discontinued parka", Price = 210.00m }
        );

        db.SaveChanges();
        Console.WriteLine($"seeded: {db.Categories.Count()} categories, {db.Items.Count()} items");
    }
    catch (SqliteException)
    {
        Console.Error.WriteLine("Seed failed: could not read the catalog store.");
        Console.Error.WriteLine("Check ConnectionStrings:Catalog in appsettings.json, and that the");
        Console.Error.WriteLine("data directory is writable by the current user.");
        Environment.Exit(1);
    }
}

void Report()
{
    using var db = new CatalogContext();

    var rows = db.Items
        .Include(i => i.Category)
        .OrderBy(i => i.Price)
        .ToList();

    Console.WriteLine("price     category        item");
    foreach (var r in rows)
        Console.WriteLine($"{r.Price,8:0.00}  {r.Category!.Name,-15} {r.Label}");
    Console.WriteLine($"\n{rows.Count} row(s)");
}

void Update()
{
    if (args.Length < 3)
    {
        Console.Error.WriteLine("usage: dotnet run -- update <id> <label>");
        Environment.Exit(1);
    }
    var id = int.Parse(args[1]);
    var label = string.Join(' ', args[2..]);

    using var db = new CatalogContext();

    var item = db.Items.AsNoTracking().FirstOrDefault(i => i.Id == id);
    if (item is null)
    {
        Console.Error.WriteLine($"no item with id {id}");
        Environment.Exit(1);
    }

    item.Label = label;
    db.SaveChanges();
    Console.WriteLine($"updated item {id} to \"{label}\"");
}
