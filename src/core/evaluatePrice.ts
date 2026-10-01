import { InvalidArgumentError, ProductNotFoundError } from '../errors.ts';
import {
  ComparisonMode,
  PriceEvaluationStatus,
  type EvaluatePriceOptions,
  type PriceEvaluationResult,
  type PriceHistory,
  type PriceHistoryRepository,
  type ProductRepository,
} from '../types.ts';
import {
  isGreaterThan,
  isLessThan,
  isLessThanOrEqual,
  round,
} from '../utils/number.ts';

/** 「お買い得」「高め」の境界。平均単価に対する比率。 */
export const GOOD_DEAL_RATIO = 0.95;
export const HIGH_RATIO = 1.05;

export interface PriceEvaluatorDeps {
  priceHistoryRepository: PriceHistoryRepository;
  /** 指定すると評価前に商品の存在チェックを行う。 */
  productRepository?: ProductRepository | undefined;
  now?: () => Date;
  generateId?: () => string;
}

export interface PriceEvaluator {
  /** 今回の価格が過去と比べて安いかを判定する (保存はしない)。 */
  evaluatePrice(
    productId: string,
    currentPrice: number,
    currentQuantity?: number,
    options?: EvaluatePriceOptions,
  ): Promise<PriceEvaluationResult>;
  /** 判定したうえで履歴に記録する。スキャン確定時に使う。 */
  recordScan(
    productId: string,
    currentPrice: number,
    currentQuantity?: number,
    options?: EvaluatePriceOptions,
  ): Promise<{ evaluation: PriceEvaluationResult; history: PriceHistory }>;
}

/** 1レコードの比較指標値。比較不能なら null。 */
function toMetric(record: PriceHistory, mode: ComparisonMode): number | null {
  if (mode === ComparisonMode.RAW_PRICE) return record.price;
  // 単価比較では容量が分からない履歴は混ぜない (500ml と 2L を比べないため)。
  if (record.unitQuantity == null || record.unitQuantity <= 0) return null;
  return record.price / record.unitQuantity;
}

function assertPositiveNumber(value: number, label: string, allowZero = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidArgumentError(`${label} は有限の数値である必要があります`);
  }
  if (allowZero ? value < 0 : value <= 0) {
    throw new InvalidArgumentError(
      `${label} は${allowZero ? '0以上' : '正の数'}である必要があります`,
    );
  }
}

export function createPriceEvaluator(deps: PriceEvaluatorDeps): PriceEvaluator {
  const {
    priceHistoryRepository,
    productRepository,
    now = () => new Date(),
    generateId = () => crypto.randomUUID(),
  } = deps;

  async function evaluatePrice(
    productId: string,
    currentPrice: number,
    currentQuantity?: number,
    options: EvaluatePriceOptions = {},
  ): Promise<PriceEvaluationResult> {
    assertPositiveNumber(currentPrice, '価格', true);
    if (currentQuantity !== undefined && currentQuantity !== null) {
      assertPositiveNumber(currentQuantity, '容量/個数');
    }

    if (productRepository) {
      const product = await productRepository.findById(productId);
      if (!product) throw new ProductNotFoundError(productId);
    }

    // 容量が指定されていれば単価、なければ単純価格で比較する。
    const mode =
      currentQuantity != null ? ComparisonMode.UNIT_PRICE : ComparisonMode.RAW_PRICE;
    const currentUnitPrice = round(
      mode === ComparisonMode.UNIT_PRICE
        ? currentPrice / (currentQuantity as number)
        : currentPrice,
    );

    const histories = await priceHistoryRepository.findByProductId(productId);

    // 比較可能な履歴だけを取り出す。
    const comparable: { record: PriceHistory; metric: number }[] = [];
    for (const record of histories) {
      if (options.since && record.scannedAt < options.since) continue;
      const metric = toMetric(record, mode);
      if (metric == null || !Number.isFinite(metric)) continue;
      comparable.push({ record, metric: round(metric) });
    }

    // 初回スキャン: 比較対象なし。
    if (comparable.length === 0) {
      return {
        status: PriceEvaluationStatus.FIRST_SCAN,
        currentUnitPrice,
        lowestUnitPrice: null,
        averageUnitPrice: null,
        differencePercentage: null,
        comparisonMode: mode,
        sampleSize: 0,
        lowestRecord: null,
      };
    }

    const lowest = comparable.reduce((min, entry) =>
      entry.metric < min.metric ? entry : min,
    );
    const lowestUnitPrice = lowest.metric;
    const averageUnitPrice = round(
      comparable.reduce((sum, entry) => sum + entry.metric, 0) / comparable.length,
    );

    const differencePercentage =
      averageUnitPrice === 0
        ? 0
        : round(((currentUnitPrice - averageUnitPrice) / averageUnitPrice) * 100, 1);

    const status = determineStatus(currentUnitPrice, lowestUnitPrice, averageUnitPrice);

    return {
      status,
      currentUnitPrice,
      lowestUnitPrice,
      averageUnitPrice,
      differencePercentage,
      comparisonMode: mode,
      sampleSize: comparable.length,
      lowestRecord: lowest.record,
    };
  }

  async function recordScan(
    productId: string,
    currentPrice: number,
    currentQuantity?: number,
    options: EvaluatePriceOptions = {},
  ) {
    const evaluation = await evaluatePrice(
      productId,
      currentPrice,
      currentQuantity,
      options,
    );
    const history = await priceHistoryRepository.add({
      id: generateId(),
      productId,
      price: currentPrice,
      unitQuantity: currentQuantity ?? null,
      storeName: options.storeName ?? null,
      scannedAt: now(),
    });
    return { evaluation, history };
  }

  return { evaluatePrice, recordScan };
}

/**
 * 判定ロジック本体。上から順に評価する。
 *   LOWEST_EVER : 今回 < 過去最安
 *   GOOD_DEAL   : 今回 <= 平均 * 0.95
 *   HIGH        : 今回 >  平均 * 1.05
 *   AVERAGE     : それ以外 (平均の ±5% 以内)
 */
function determineStatus(
  current: number,
  lowest: number,
  average: number,
): PriceEvaluationStatus {
  if (isLessThan(current, lowest)) return PriceEvaluationStatus.LOWEST_EVER;
  if (isLessThanOrEqual(current, average * GOOD_DEAL_RATIO)) {
    return PriceEvaluationStatus.GOOD_DEAL;
  }
  if (isGreaterThan(current, average * HIGH_RATIO)) return PriceEvaluationStatus.HIGH;
  return PriceEvaluationStatus.AVERAGE;
}
