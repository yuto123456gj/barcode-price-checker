import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createPriceEvaluator } from '../src/core/evaluatePrice.ts';
import { createProductResolver } from '../src/core/resolveProduct.ts';
import { createSqliteStore } from '../src/repositories/sqlite.ts';
import { PriceEvaluationStatus, ProductStatus, type Product } from '../src/types.ts';
import { StubSearchClient, makeHistory, makeProduct } from './helpers.ts';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'barcode-test-'));
  tempDirs.push(dir);
  return join(dir, 'test.db');
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('SqliteProductRepository', () => {
  it('保存した商品をJANコード・IDの両方で引ける', async () => {
    const store = createSqliteStore();
    const product = makeProduct({
      id: 'p1',
      janCode: '4901777300446',
      name: 'コカ・コーラ 500ml',
      imageUrl: 'https://img/1.jpg',
    });

    await store.productRepository.save(product);

    const byCode = await store.productRepository.findByJanCode('4901777300446');
    const byId = await store.productRepository.findById('p1');

    assert.deepEqual(byCode, product);
    assert.deepEqual(byId, product);
    store.close();
  });

  it('null・boolean・Date を往復させても値が壊れない', async () => {
    const store = createSqliteStore();
    const draft = makeProduct({
      id: 'p2',
      janCode: '2100123000009',
      name: null,
      imageUrl: null,
      isInstore: true,
      createdAt: new Date('2026-09-25T12:34:56.000Z'),
    });

    await store.productRepository.save(draft);
    const loaded = await store.productRepository.findByJanCode('2100123000009');

    assert.equal(loaded?.name, null);
    assert.equal(loaded?.imageUrl, null);
    assert.equal(loaded?.isInstore, true, 'boolean は 0/1 で往復する');
    assert.ok(loaded?.createdAt instanceof Date);
    assert.equal(loaded.createdAt.toISOString(), '2026-09-25T12:34:56.000Z');
    store.close();
  });

  it('存在しないコードは null', async () => {
    const store = createSqliteStore();
    assert.equal(await store.productRepository.findByJanCode('0000000000000'), null);
    assert.equal(await store.productRepository.findById('missing'), null);
    store.close();
  });

  it('同じIDで保存すると上書きになる (二重登録しない)', async () => {
    const store = createSqliteStore();
    const product = makeProduct({ id: 'p3', janCode: '4901777300446', name: null });

    await store.productRepository.save(product);
    const updated = await store.productRepository.save({
      ...product,
      name: '手入力した商品名',
    });

    assert.equal(updated.name, '手入力した商品名');
    assert.equal(store.productRepository.size, 1);
    store.close();
  });

  it('同じJANコードを別IDで保存しても既存の行を更新する', async () => {
    const store = createSqliteStore();
    const original: Product = makeProduct({
      id: 'original',
      janCode: '4901777300446',
      name: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await store.productRepository.save(original);

    const saved = await store.productRepository.save(
      makeProduct({ id: 'another-uuid', janCode: '4901777300446', name: '確定した名前' }),
    );

    assert.equal(saved.id, 'original', '既存IDを維持する');
    assert.equal(saved.name, '確定した名前');
    assert.equal(
      saved.createdAt.toISOString(),
      '2026-01-01T00:00:00.000Z',
      '作成日時は維持する',
    );
    assert.equal(store.productRepository.size, 1);
    store.close();
  });
});

describe('SqlitePriceHistoryRepository', () => {
  it('商品ごとに履歴を取得し、古い順に並べる', async () => {
    const store = createSqliteStore();
    await store.productRepository.save(makeProduct({ id: 'p1' }));
    await store.productRepository.save(
      makeProduct({ id: 'p2', janCode: '4901777300453' }),
    );

    await store.priceHistoryRepository.add(
      makeHistory({
        id: 'h2',
        productId: 'p1',
        price: 120,
        scannedAt: new Date('2026-03-01T00:00:00Z'),
      }),
    );
    await store.priceHistoryRepository.add(
      makeHistory({
        id: 'h1',
        productId: 'p1',
        price: 150,
        unitQuantity: 500,
        storeName: '店A',
        scannedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    await store.priceHistoryRepository.add(makeHistory({ id: 'h3', productId: 'p2' }));

    const histories = await store.priceHistoryRepository.findByProductId('p1');

    assert.deepEqual(
      histories.map((h) => h.id),
      ['h1', 'h2'],
    );
    assert.equal(histories[0]?.unitQuantity, 500);
    assert.equal(histories[0]?.storeName, '店A');
    assert.equal(histories[1]?.unitQuantity, null);
    assert.equal(store.priceHistoryRepository.size, 3);
    store.close();
  });

  it('存在しない商品IDの履歴は外部キー制約で弾く', async () => {
    const store = createSqliteStore();

    await assert.rejects(() =>
      store.priceHistoryRepository.add(makeHistory({ productId: 'ghost' })),
    );
    store.close();
  });
});

describe('ファイル永続化', () => {
  it('DBを閉じて開き直してもデータが残る', async () => {
    const path = tempDbPath();

    const first = createSqliteStore(path);
    const product = await first.productRepository.save(
      makeProduct({ id: 'persisted', janCode: '4901777300446', name: '保存テスト' }),
    );
    await first.priceHistoryRepository.add(
      makeHistory({ id: 'h1', productId: product.id, price: 198 }),
    );
    first.close();

    const second = createSqliteStore(path);
    const loaded = await second.productRepository.findByJanCode('4901777300446');
    const histories = await second.priceHistoryRepository.findByProductId('persisted');

    assert.equal(loaded?.name, '保存テスト');
    assert.equal(histories.length, 1);
    assert.equal(histories[0]?.price, 198);
    second.close();
  });
});

describe('SQLite を使った通し動作', () => {
  it('インメモリ実装と同じ判定結果になる (生鮮食品の3回スキャン)', async () => {
    const store = createSqliteStore();
    const resolver = createProductResolver({
      productRepository: store.productRepository,
      searchClient: new StubSearchClient(async () => null),
      now: () => new Date('2026-09-25T00:00:00Z'),
    });
    const evaluator = createPriceEvaluator({
      priceHistoryRepository: store.priceHistoryRepository,
      productRepository: store.productRepository,
    });

    // 1回目: 498円 のインストアコード → 手動入力して登録。
    const first = await resolver.resolveProduct('2100123004985');
    assert.equal(first.status, ProductStatus.REQUIRES_MANUAL_INPUT);
    assert.equal(first.instore?.price, 498);
    const product = await resolver.registerManualProduct('2100123004985', {
      name: '国産豚バラ肉 100g',
    });
    const scan1 = await evaluator.recordScan(product.id, first.instore!.price!, 100);
    assert.equal(scan1.evaluation.status, PriceEvaluationStatus.FIRST_SCAN);

    // 2回目: 398円。名寄せされて同じ商品にヒットする。
    const second = await resolver.resolveProduct('2100123003986');
    assert.equal(second.status, ProductStatus.RESOLVED);
    assert.equal(second.product.id, product.id);
    const scan2 = await evaluator.recordScan(second.product.id, 398, 100);
    assert.equal(scan2.evaluation.status, PriceEvaluationStatus.LOWEST_EVER);

    // 3回目: 448円。平均 448 の ±5% 以内 → AVERAGE。
    const third = await evaluator.evaluatePrice(product.id, 448, 100);
    assert.equal(third.status, PriceEvaluationStatus.AVERAGE);
    assert.equal(third.sampleSize, 2);
    assert.equal(third.lowestUnitPrice, 3.98);
    assert.equal(store.productRepository.size, 1, '商品は1件だけ');
    store.close();
  });
});
