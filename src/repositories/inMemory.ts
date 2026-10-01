import type {
  PriceHistory,
  PriceHistoryRepository,
  Product,
  ProductRepository,
} from '../types.ts';

/**
 * インメモリ実装。テストとローカル開発用。
 * 本番では SQLite / Realm / Firestore などに差し替える
 * ({@link ProductRepository} / {@link PriceHistoryRepository} を満たせばよい)。
 */
export class InMemoryProductRepository implements ProductRepository {
  private readonly byId = new Map<string, Product>();
  private readonly idByJanCode = new Map<string, string>();

  constructor(seed: Product[] = []) {
    for (const product of seed) this.saveSync(product);
  }

  async findByJanCode(janCode: string): Promise<Product | null> {
    const id = this.idByJanCode.get(janCode);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findById(productId: string): Promise<Product | null> {
    return this.byId.get(productId) ?? null;
  }

  async save(product: Product): Promise<Product> {
    return this.saveSync(product);
  }

  /** 保存済み件数 (テスト用)。 */
  get size(): number {
    return this.byId.size;
  }

  private saveSync(product: Product): Product {
    const stored = { ...product };
    this.byId.set(stored.id, stored);
    this.idByJanCode.set(stored.janCode, stored.id);
    return stored;
  }
}

export class InMemoryPriceHistoryRepository implements PriceHistoryRepository {
  private readonly records: PriceHistory[] = [];

  constructor(seed: PriceHistory[] = []) {
    this.records.push(...seed.map((record) => ({ ...record })));
  }

  async findByProductId(productId: string): Promise<PriceHistory[]> {
    return this.records
      .filter((record) => record.productId === productId)
      .map((record) => ({ ...record }));
  }

  async add(history: PriceHistory): Promise<PriceHistory> {
    const stored = { ...history };
    this.records.push(stored);
    return { ...stored };
  }

  get size(): number {
    return this.records.length;
  }
}
