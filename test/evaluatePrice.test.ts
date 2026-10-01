import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPriceEvaluator } from '../src/core/evaluatePrice.ts';
import { InvalidArgumentError, ProductNotFoundError } from '../src/errors.ts';
import {
  InMemoryPriceHistoryRepository,
  InMemoryProductRepository,
} from '../src/repositories/inMemory.ts';
import {
  ComparisonMode,
  PriceEvaluationStatus,
  type PriceHistory,
} from '../src/types.ts';
import { makeHistory, makeProduct } from './helpers.ts';

const PRODUCT_ID = 'product-under-test';

function setup(histories: Partial<PriceHistory>[] = []) {
  const priceHistoryRepository = new InMemoryPriceHistoryRepository(
    histories.map((h) => makeHistory({ productId: PRODUCT_ID, ...h })),
  );
  const evaluator = createPriceEvaluator({ priceHistoryRepository });
  return { evaluator, priceHistoryRepository };
}

describe('evaluatePrice', () => {
  describe('FIRST_SCAN', () => {
    it('履歴がなければ FIRST_SCAN を返し、比較値は null になる', async () => {
      const { evaluator } = setup([]);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 198);

      assert.equal(result.status, PriceEvaluationStatus.FIRST_SCAN);
      assert.equal(result.currentUnitPrice, 198);
      assert.equal(result.lowestUnitPrice, null);
      assert.equal(result.averageUnitPrice, null);
      assert.equal(result.differencePercentage, null);
      assert.equal(result.sampleSize, 0);
      assert.equal(result.lowestRecord, null);
    });

    it('他商品の履歴は混ざらない', async () => {
      const priceHistoryRepository = new InMemoryPriceHistoryRepository([
        makeHistory({ productId: 'other-product', price: 100 }),
      ]);
      const evaluator = createPriceEvaluator({ priceHistoryRepository });

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 500);

      assert.equal(result.status, PriceEvaluationStatus.FIRST_SCAN);
    });

    it('単価比較なのに容量つき履歴が1件もなければ FIRST_SCAN 扱い', async () => {
      // 500ml の単価を、容量不明の履歴と比べても意味がないため比較対象外にする。
      const { evaluator } = setup([{ price: 150, unitQuantity: null }]);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 200, 1000);

      assert.equal(result.status, PriceEvaluationStatus.FIRST_SCAN);
      assert.equal(result.comparisonMode, ComparisonMode.UNIT_PRICE);
      assert.equal(result.currentUnitPrice, 0.2);
      assert.equal(result.sampleSize, 0);
    });
  });

  describe('LOWEST_EVER', () => {
    it('過去最安値を下回れば LOWEST_EVER', async () => {
      const { evaluator } = setup([
        { price: 150, storeName: 'スーパーA' },
        { price: 120, storeName: 'スーパーB' },
        { price: 180, storeName: 'スーパーC' },
      ]);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 110);

      assert.equal(result.status, PriceEvaluationStatus.LOWEST_EVER);
      assert.equal(result.lowestUnitPrice, 120);
      assert.equal(result.averageUnitPrice, 150);
      assert.equal(result.differencePercentage, -26.7);
      assert.equal(result.sampleSize, 3);
      assert.equal(result.lowestRecord?.storeName, 'スーパーB');
    });

    it('最安値と同額は更新ではない (LOWEST_EVER にしない)', async () => {
      const { evaluator } = setup([{ price: 120 }, { price: 180 }]);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 120);

      // 平均150 の 95% = 142.5 以下なので GOOD_DEAL。
      assert.equal(result.status, PriceEvaluationStatus.GOOD_DEAL);
    });

    it('単価ベースでも最安判定できる (総額は高いが単価は安いケース)', async () => {
      const { evaluator } = setup([
        { price: 200, unitQuantity: 500 }, // 0.4 円/ml
        { price: 300, unitQuantity: 1000 }, // 0.3 円/ml
      ]);

      // 総額 500円 は過去最高額だが、2L なので単価 0.25 円/ml。
      const result = await evaluator.evaluatePrice(PRODUCT_ID, 500, 2000);

      assert.equal(result.status, PriceEvaluationStatus.LOWEST_EVER);
      assert.equal(result.comparisonMode, ComparisonMode.UNIT_PRICE);
      assert.equal(result.currentUnitPrice, 0.25);
      assert.equal(result.lowestUnitPrice, 0.3);
      assert.equal(result.averageUnitPrice, 0.35);
    });
  });

  describe('GOOD_DEAL / AVERAGE / HIGH', () => {
    // 平均 200円、最安 180円 の履歴。境界値を狙って検証する。
    const histories = [{ price: 180 }, { price: 200 }, { price: 220 }];

    it('平均のちょうど95% は GOOD_DEAL (境界を含む)', async () => {
      const { evaluator } = setup(histories);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 190);

      assert.equal(result.status, PriceEvaluationStatus.GOOD_DEAL);
      assert.equal(result.differencePercentage, -5);
    });

    it('平均より5%以上安ければ GOOD_DEAL', async () => {
      const { evaluator } = setup(histories);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 185);

      assert.equal(result.status, PriceEvaluationStatus.GOOD_DEAL);
      assert.equal(result.lowestUnitPrice, 180);
    });

    it('平均の±5%以内は AVERAGE', async () => {
      const { evaluator } = setup(histories);

      for (const price of [191, 200, 210]) {
        const result = await evaluator.evaluatePrice(PRODUCT_ID, price);
        assert.equal(result.status, PriceEvaluationStatus.AVERAGE, `${price}円`);
      }
    });

    it('平均のちょうど105% は AVERAGE、超えたら HIGH', async () => {
      const { evaluator } = setup(histories);

      assert.equal(
        (await evaluator.evaluatePrice(PRODUCT_ID, 210)).status,
        PriceEvaluationStatus.AVERAGE,
      );
      assert.equal(
        (await evaluator.evaluatePrice(PRODUCT_ID, 211)).status,
        PriceEvaluationStatus.HIGH,
      );
    });

    it('HIGH のとき差分は正の値になる', async () => {
      const { evaluator } = setup(histories);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 250);

      assert.equal(result.status, PriceEvaluationStatus.HIGH);
      assert.equal(result.differencePercentage, 25);
    });
  });

  describe('比較指標の選択', () => {
    it('容量未指定なら単純価格で比較する', async () => {
      const { evaluator } = setup([{ price: 100, unitQuantity: 500 }]);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 120);

      assert.equal(result.comparisonMode, ComparisonMode.RAW_PRICE);
      assert.equal(result.currentUnitPrice, 120);
      assert.equal(result.lowestUnitPrice, 100, '履歴側も総額で比較する');
    });

    it('単価比較では容量なしの履歴を除外する', async () => {
      const { evaluator } = setup([
        { price: 100, unitQuantity: 500 }, // 0.2
        { price: 9999, unitQuantity: null }, // 除外される
      ]);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 150, 1000);

      assert.equal(result.sampleSize, 1);
      assert.equal(result.averageUnitPrice, 0.2);
      assert.equal(result.currentUnitPrice, 0.15);
      assert.equal(result.status, PriceEvaluationStatus.LOWEST_EVER);
    });

    it('割り切れない単価でも浮動小数の誤差で判定がブレない', async () => {
      // 0.1 + 0.2 問題のような誤差で AVERAGE/GOOD_DEAL がひっくり返らないこと。
      const { evaluator } = setup([{ price: 100, unitQuantity: 3 }]); // 33.3333

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 100, 3);

      assert.equal(result.status, PriceEvaluationStatus.AVERAGE);
      assert.equal(result.differencePercentage, 0);
    });

    it('since で比較対象期間を絞れる', async () => {
      const { evaluator } = setup([
        { price: 100, scannedAt: new Date('2025-01-01T00:00:00Z') }, // 古い
        { price: 300, scannedAt: new Date('2026-09-01T00:00:00Z') },
      ]);

      const result = await evaluator.evaluatePrice(PRODUCT_ID, 200, undefined, {
        since: new Date('2026-01-01T00:00:00Z'),
      });

      assert.equal(result.sampleSize, 1);
      assert.equal(result.status, PriceEvaluationStatus.LOWEST_EVER);
    });
  });

  describe('入力バリデーション', () => {
    it('価格が負・NaN なら InvalidArgumentError', async () => {
      const { evaluator } = setup([]);

      await assert.rejects(
        () => evaluator.evaluatePrice(PRODUCT_ID, -1),
        InvalidArgumentError,
      );
      await assert.rejects(
        () => evaluator.evaluatePrice(PRODUCT_ID, Number.NaN),
        InvalidArgumentError,
      );
    });

    it('容量が0以下なら InvalidArgumentError (ゼロ除算を防ぐ)', async () => {
      const { evaluator } = setup([]);

      await assert.rejects(
        () => evaluator.evaluatePrice(PRODUCT_ID, 100, 0),
        InvalidArgumentError,
      );
    });

    it('productRepository を渡した場合、存在しない商品は ProductNotFoundError', async () => {
      const evaluator = createPriceEvaluator({
        priceHistoryRepository: new InMemoryPriceHistoryRepository(),
        productRepository: new InMemoryProductRepository(),
      });

      await assert.rejects(
        () => evaluator.evaluatePrice('missing', 100),
        ProductNotFoundError,
      );
    });
  });

  describe('recordScan', () => {
    it('判定結果を返しつつ履歴を1件追加する', async () => {
      const productRepository = new InMemoryProductRepository([
        makeProduct({ id: PRODUCT_ID }),
      ]);
      const priceHistoryRepository = new InMemoryPriceHistoryRepository([
        makeHistory({ productId: PRODUCT_ID, price: 200 }),
      ]);
      const evaluator = createPriceEvaluator({
        priceHistoryRepository,
        productRepository,
        now: () => new Date('2026-09-25T12:00:00Z'),
        generateId: () => 'history-fixed',
      });

      const { evaluation, history } = await evaluator.recordScan(
        PRODUCT_ID,
        150,
        undefined,
        { storeName: 'ドラッグストアD' },
      );

      assert.equal(evaluation.status, PriceEvaluationStatus.LOWEST_EVER);
      assert.equal(history.id, 'history-fixed');
      assert.equal(history.storeName, 'ドラッグストアD');
      assert.equal(priceHistoryRepository.size, 2);

      // 2回目は保存済みの150円が最安として効く。
      const second = await evaluator.evaluatePrice(PRODUCT_ID, 150);
      assert.equal(second.status, PriceEvaluationStatus.GOOD_DEAL);
      assert.equal(second.lowestUnitPrice, 150);
    });
  });
});
