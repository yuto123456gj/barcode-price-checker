import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  InMemoryPriceHistoryRepository,
  InMemoryProductRepository,
  PriceEvaluationStatus,
  ProductStatus,
  configureBarcodeModule,
  evaluatePriceByJanCode,
  recordScan,
  registerManualProduct,
  resolveProduct,
} from '../src/index.ts';
import { createSqliteStore } from '../src/repositories/sqlite.ts';
import { StubSearchClient } from './helpers.ts';

const JAN = '4901777300446';
const INSTORE = '2100123004567';

describe('スキャンから判定までの一連の流れ', () => {
  let productRepository: InMemoryProductRepository;
  let priceHistoryRepository: InMemoryPriceHistoryRepository;

  beforeEach(() => {
    productRepository = new InMemoryProductRepository();
    priceHistoryRepository = new InMemoryPriceHistoryRepository();
  });

  it('通常JAN: API解決 → 初回スキャン → 2回目で最安値更新', async () => {
    configureBarcodeModule({
      productRepository,
      priceHistoryRepository,
      searchClient: new StubSearchClient(async () => ({
        name: 'サントリー 天然水 550ml',
        imageUrl: null,
        provider: 'yahoo',
      })),
    });

    const scan = await resolveProduct(JAN);
    assert.equal(scan.status, ProductStatus.RESOLVED);

    const first = await recordScan(scan.product.id, 128, 550, { storeName: '店A' });
    assert.equal(first.evaluation.status, PriceEvaluationStatus.FIRST_SCAN);

    const second = await evaluatePriceByJanCode(JAN, 88, 550);
    assert.equal(second.status, PriceEvaluationStatus.LOWEST_EVER);
    assert.equal(second.sampleSize, 1);
  });

  it('インストアコード: 手動入力で登録してから価格を積み上げる', async () => {
    configureBarcodeModule({
      productRepository,
      priceHistoryRepository,
      searchClient: new StubSearchClient(async () => {
        throw new Error('インストアコードでAPIを呼んではいけない');
      }),
    });

    const scan = await resolveProduct(INSTORE);
    assert.equal(scan.status, ProductStatus.REQUIRES_MANUAL_INPUT);
    assert.equal(scan.product.isInstore, true);

    const product = await registerManualProduct(INSTORE, { name: '国産豚バラ肉 100g' });
    await recordScan(product.id, 298, 100, { storeName: '店A' });
    await recordScan(product.id, 258, 100, { storeName: '店B' });

    // 100gあたり 2.38円。過去 (2.98 / 2.58、平均2.78) より安い。
    const result = await evaluatePriceByJanCode(INSTORE, 238, 100);
    assert.equal(result.status, PriceEvaluationStatus.LOWEST_EVER);
    assert.equal(result.lowestRecord?.storeName, '店B');
  });

  it('価格埋め込みインストアコード: 価格が変わっても履歴が1商品に積み上がる', async () => {
    configureBarcodeModule({
      productRepository,
      priceHistoryRepository,
      searchClient: new StubSearchClient(async () => null),
    });

    // 498円 → 398円 → 448円 と、スキャンのたびにバーコード文字列自体が変わる。
    const first = await resolveProduct('2100123004985');
    assert.equal(first.instore?.price, 498);
    const product = await registerManualProduct('2100123004985', {
      name: '国産豚バラ肉 100g',
    });
    await recordScan(product.id, 498, 100);

    const second = await resolveProduct('2100123003986');
    assert.equal(second.status, ProductStatus.RESOLVED, '同一商品として解決される');
    await recordScan(second.product.id, 398, 100);

    // 公開APIもコードから名寄せキーに変換して照合する。
    const result = await evaluatePriceByJanCode('2100123004487', 448, 100);
    assert.equal(result.status, PriceEvaluationStatus.AVERAGE);
    assert.equal(result.sampleSize, 2);
    assert.equal(productRepository.size, 1);
  });

  it('SQLite でも同じ流れが通る', async () => {
    const store = createSqliteStore();
    configureBarcodeModule({
      productRepository: store.productRepository,
      priceHistoryRepository: store.priceHistoryRepository,
      searchClient: new StubSearchClient(async () => ({
        name: 'サントリー 天然水 550ml',
        imageUrl: null,
        provider: 'yahoo',
      })),
    });

    const scan = await resolveProduct(JAN);
    assert.equal(scan.status, ProductStatus.RESOLVED);
    await recordScan(scan.product.id, 128, 550);

    const result = await evaluatePriceByJanCode(JAN, 88, 550);
    assert.equal(result.status, PriceEvaluationStatus.LOWEST_EVER);
    store.close();
  });

  it('PB商品: API該当なし → 手動入力 → 以降はローカルヒット', async () => {
    configureBarcodeModule({
      productRepository,
      priceHistoryRepository,
      searchClient: new StubSearchClient(async () => null),
    });

    const scan = await resolveProduct(JAN);
    assert.equal(scan.status, ProductStatus.REQUIRES_MANUAL_INPUT);

    await registerManualProduct(JAN, { name: 'トップバリュ 炭酸水 500ml' });

    const again = await resolveProduct(JAN);
    assert.equal(again.status, ProductStatus.RESOLVED);
    assert.equal(again.product.name, 'トップバリュ 炭酸水 500ml');
  });
});
