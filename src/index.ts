/**
 * バーコードスキャン & 価格比較モジュールの公開API。
 *
 * 2通りの使い方ができる:
 *   1. 依存を注入したファクトリ (createProductResolver / createPriceEvaluator)
 *      → 本番DBやモックを差し込む。テストはこちらを使う。
 *   2. 既定コンテナ経由のトップレベル関数 (resolveProduct / evaluatePrice)
 *      → 仕様書どおりのシグネチャ。アプリ起動時に configureBarcodeModule() で
 *        リポジトリと検索クライアントを登録する。
 */

import { createPriceEvaluator, type PriceEvaluator } from './core/evaluatePrice.ts';
import { createProductResolver, type ProductResolver } from './core/resolveProduct.ts';
import {
  InMemoryPriceHistoryRepository,
  InMemoryProductRepository,
} from './repositories/inMemory.ts';
import { ProductNotFoundError } from './errors.ts';
import type {
  EvaluatePriceOptions,
  InstoreCodeLayout,
  PriceEvaluationResult,
  PriceHistoryRepository,
  ProductRepository,
  ProductResolutionResult,
  ProductSearchClient,
} from './types.ts';

export * from './types.ts';
export * from './errors.ts';
export * from './utils/janCode.ts';
export * from './utils/instoreCode.ts';
export { createProductResolver } from './core/resolveProduct.ts';
export type { ProductResolver, ProductResolverDeps } from './core/resolveProduct.ts';
export {
  createPriceEvaluator,
  GOOD_DEAL_RATIO,
  HIGH_RATIO,
} from './core/evaluatePrice.ts';
export type { PriceEvaluator, PriceEvaluatorDeps } from './core/evaluatePrice.ts';
export {
  InMemoryPriceHistoryRepository,
  InMemoryProductRepository,
} from './repositories/inMemory.ts';
export {
  createSqliteStore,
  SqlitePriceHistoryRepository,
  SqliteProductRepository,
} from './repositories/sqlite.ts';
export type { SqliteStore } from './repositories/sqlite.ts';
export {
  FallbackSearchClient,
  RakutenIchibaSearchClient,
  YahooShoppingSearchClient,
} from './api/searchClients.ts';
export type { SearchClientOptions } from './api/searchClients.ts';

/* -------------------------------------------------------------------------- */
/* 既定コンテナ                                                                */
/* -------------------------------------------------------------------------- */

export interface BarcodeModuleConfig {
  productRepository?: ProductRepository;
  priceHistoryRepository?: PriceHistoryRepository;
  searchClient?: ProductSearchClient;
  /** インストアコードの桁構成。既定は価格埋め込み13桁。 */
  instoreLayouts?: InstoreCodeLayout[];
  /** 価格埋め込みコードを商品コードで名寄せするか (既定: true)。 */
  mergeInstoreByItemCode?: boolean;
}

interface Container {
  productRepository: ProductRepository;
  priceHistoryRepository: PriceHistoryRepository;
  resolver: ProductResolver;
  evaluator: PriceEvaluator;
}

function buildContainer(config: BarcodeModuleConfig): Container {
  const productRepository = config.productRepository ?? new InMemoryProductRepository();
  const priceHistoryRepository =
    config.priceHistoryRepository ?? new InMemoryPriceHistoryRepository();

  return {
    productRepository,
    priceHistoryRepository,
    resolver: createProductResolver({
      productRepository,
      searchClient: config.searchClient,
      ...(config.instoreLayouts ? { instoreLayouts: config.instoreLayouts } : {}),
      ...(config.mergeInstoreByItemCode !== undefined
        ? { mergeInstoreByItemCode: config.mergeInstoreByItemCode }
        : {}),
    }),
    evaluator: createPriceEvaluator({ priceHistoryRepository, productRepository }),
  };
}

let container: Container = buildContainer({});

/** アプリ起動時に一度呼び、実DBや外部APIクライアントを登録する。 */
export function configureBarcodeModule(config: BarcodeModuleConfig): void {
  container = buildContainer(config);
}

/** バーコードから商品を特定する (仕様書 A)。 */
export function resolveProduct(janCode: string): Promise<ProductResolutionResult> {
  return container.resolver.resolveProduct(janCode);
}

/** 手動入力された商品名を確定登録する。 */
export function registerManualProduct(
  janCode: string,
  input: { name: string; imageUrl?: string | null },
) {
  return container.resolver.registerManualProduct(janCode, input);
}

/** 価格を過去履歴と比較して判定する (仕様書 B)。 */
export function evaluatePrice(
  productId: string,
  currentPrice: number,
  currentQuantity?: number,
  options?: EvaluatePriceOptions,
): Promise<PriceEvaluationResult> {
  return container.evaluator.evaluatePrice(
    productId,
    currentPrice,
    currentQuantity,
    options,
  );
}

/**
 * JANコード起点で判定する版。
 * スキャン画面からは productId を持っていないことが多いのでこちらが実用的。
 *
 * 価格埋め込みインストアコードは名寄せキーに変換してから照合するので、
 * 前回と価格が違うコードをスキャンしても同じ商品の履歴に当たる。
 */
export async function evaluatePriceByJanCode(
  janCode: string,
  currentPrice: number,
  currentQuantity?: number,
  options?: EvaluatePriceOptions,
): Promise<PriceEvaluationResult> {
  const product = await container.productRepository.findByJanCode(
    container.resolver.toLookupKey(janCode),
  );
  if (!product) throw new ProductNotFoundError(janCode);
  return evaluatePrice(product.id, currentPrice, currentQuantity, options);
}

/** 判定と履歴保存をまとめて行う (スキャン確定時)。 */
export function recordScan(
  productId: string,
  currentPrice: number,
  currentQuantity?: number,
  options?: EvaluatePriceOptions,
) {
  return container.evaluator.recordScan(
    productId,
    currentPrice,
    currentQuantity,
    options,
  );
}
