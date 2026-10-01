import type {
  ExternalProductInfo,
  PriceHistory,
  Product,
  ProductSearchClient,
} from '../src/types.ts';

/** 呼び出し回数を記録するスタブ検索クライアント。 */
export class StubSearchClient implements ProductSearchClient {
  readonly name: string;
  readonly calls: string[] = [];
  private readonly handler: (janCode: string) => Promise<ExternalProductInfo | null>;

  constructor(
    handler: (janCode: string) => Promise<ExternalProductInfo | null>,
    name = 'stub',
  ) {
    this.handler = handler;
    this.name = name;
  }

  async searchByJanCode(janCode: string): Promise<ExternalProductInfo | null> {
    this.calls.push(janCode);
    return this.handler(janCode);
  }
}

let sequence = 0;
/** テスト内で決定的なIDを振る。 */
export function nextId(prefix = 'id'): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: overrides.id ?? nextId('product'),
    janCode: overrides.janCode ?? '4901777300446',
    name: overrides.name !== undefined ? overrides.name : 'テスト商品',
    imageUrl: overrides.imageUrl !== undefined ? overrides.imageUrl : null,
    isInstore: overrides.isInstore ?? false,
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}

export function makeHistory(overrides: Partial<PriceHistory> = {}): PriceHistory {
  return {
    id: overrides.id ?? nextId('history'),
    productId: overrides.productId ?? 'product-1',
    price: overrides.price ?? 100,
    unitQuantity: overrides.unitQuantity !== undefined ? overrides.unitQuantity : null,
    storeName: overrides.storeName !== undefined ? overrides.storeName : null,
    scannedAt: overrides.scannedAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}
