import { DatabaseSync } from 'node:sqlite';

import type {
  PriceHistory,
  PriceHistoryRepository,
  Product,
  ProductRepository,
} from '../types.ts';

/**
 * Node 組み込みの `node:sqlite` を使った永続化実装。外部依存なしで動く。
 *
 * 日付は ISO8601 文字列、真偽値は 0/1 で保存する (SQLite に専用型がないため)。
 */

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS products (
    id          TEXT PRIMARY KEY,
    jan_code    TEXT NOT NULL UNIQUE,
    name        TEXT,
    image_url   TEXT,
    is_instore  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS price_histories (
    id            TEXT PRIMARY KEY,
    product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price         REAL NOT NULL,
    unit_quantity REAL,
    store_name    TEXT,
    scanned_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_histories_product
    ON price_histories (product_id, scanned_at);
`;

interface ProductRow {
  id: string;
  jan_code: string;
  name: string | null;
  image_url: string | null;
  is_instore: number;
  created_at: string;
}

interface HistoryRow {
  id: string;
  product_id: string;
  price: number;
  unit_quantity: number | null;
  store_name: string | null;
  scanned_at: string;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    janCode: row.jan_code,
    name: row.name,
    imageUrl: row.image_url,
    isInstore: row.is_instore === 1,
    createdAt: new Date(row.created_at),
  };
}

function toHistory(row: HistoryRow): PriceHistory {
  return {
    id: row.id,
    productId: row.product_id,
    price: row.price,
    unitQuantity: row.unit_quantity,
    storeName: row.store_name,
    scannedAt: new Date(row.scanned_at),
  };
}

export class SqliteProductRepository implements ProductRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async findByJanCode(janCode: string): Promise<Product | null> {
    const row = this.db
      .prepare('SELECT * FROM products WHERE jan_code = ?')
      .get(janCode) as ProductRow | undefined;
    return row ? toProduct(row) : null;
  }

  async findById(productId: string): Promise<Product | null> {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as
      | ProductRow
      | undefined;
    return row ? toProduct(row) : null;
  }

  /**
   * INSERT or UPDATE。
   * jan_code が既存なら既存行の id / created_at を維持して内容だけ更新する
   * (同じ商品を別IDで二重登録しないため)。
   */
  async save(product: Product): Promise<Product> {
    const row = this.db
      .prepare(
        `INSERT INTO products (id, jan_code, name, image_url, is_instore, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           jan_code   = excluded.jan_code,
           name       = excluded.name,
           image_url  = excluded.image_url,
           is_instore = excluded.is_instore
         ON CONFLICT(jan_code) DO UPDATE SET
           name       = excluded.name,
           image_url  = excluded.image_url,
           is_instore = excluded.is_instore
         RETURNING *`,
      )
      .get(
        product.id,
        product.janCode,
        product.name,
        product.imageUrl,
        product.isInstore ? 1 : 0,
        product.createdAt.toISOString(),
      ) as unknown as ProductRow;
    return toProduct(row);
  }

  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM products').get() as {
      n: number;
    };
    return row.n;
  }
}

export class SqlitePriceHistoryRepository implements PriceHistoryRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async findByProductId(productId: string): Promise<PriceHistory[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM price_histories WHERE product_id = ? ORDER BY scanned_at ASC',
      )
      .all(productId) as unknown as HistoryRow[];
    return rows.map(toHistory);
  }

  async add(history: PriceHistory): Promise<PriceHistory> {
    const row = this.db
      .prepare(
        `INSERT INTO price_histories
           (id, product_id, price, unit_quantity, store_name, scanned_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        history.id,
        history.productId,
        history.price,
        history.unitQuantity,
        history.storeName,
        history.scannedAt.toISOString(),
      ) as unknown as HistoryRow;
    return toHistory(row);
  }

  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM price_histories').get() as {
      n: number;
    };
    return row.n;
  }
}

export interface SqliteStore {
  db: DatabaseSync;
  productRepository: SqliteProductRepository;
  priceHistoryRepository: SqlitePriceHistoryRepository;
  close(): void;
}

/**
 * DBを開き、スキーマを用意してリポジトリ一式を返す。
 *
 * @param location ファイルパス、または ':memory:' (既定。テスト用)
 */
export function createSqliteStore(location = ':memory:'): SqliteStore {
  const db = new DatabaseSync(location);
  // :memory: では WAL が使えないので個別に実行し、失敗しても続行する。
  for (const statement of SCHEMA.split(';')) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      db.exec(sql);
    } catch (error) {
      if (!sql.startsWith('PRAGMA')) throw error;
    }
  }

  return {
    db,
    productRepository: new SqliteProductRepository(db),
    priceHistoryRepository: new SqlitePriceHistoryRepository(db),
    close: () => db.close(),
  };
}
