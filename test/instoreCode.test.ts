import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProductResolver } from '../src/core/resolveProduct.ts';
import { InMemoryProductRepository } from '../src/repositories/inMemory.ts';
import {
  DEFAULT_INSTORE_LAYOUTS,
  JP_WEIGHT_EMBEDDED_13,
  buildCanonicalCode,
  parseInstoreCode,
  toLookupKey,
} from '../src/utils/instoreCode.ts';
import { hasValidCheckDigit } from '../src/utils/janCode.ts';
import { ManualInputReason, ProductStatus, type InstoreCodeLayout } from '../src/types.ts';
import { StubSearchClient } from './helpers.ts';

/**
 * 2 1 | 0 0 1 2 3 | 0 0 4 9 8 | C
 * 先頭2桁=21 / 商品コード=00123 / 価格=498円
 */
const PRICE_498 = '2100123004985';
const PRICE_398 = '2100123003986';

describe('parseInstoreCode', () => {
  it('価格埋め込みコードから商品コードと価格を取り出す', () => {
    const info = parseInstoreCode(PRICE_498);

    assert.ok(info);
    assert.equal(info.layoutName, 'JP_PRICE_EMBEDDED_13');
    assert.equal(info.prefix, '21');
    assert.equal(info.itemCode, '00123');
    assert.equal(info.price, 498);
    assert.equal(info.weight, null);
    assert.equal(info.raw, PRICE_498);
  });

  it('価格が違う同一商品は同じ名寄せキーになる', () => {
    const a = parseInstoreCode(PRICE_498);
    const b = parseInstoreCode(PRICE_398);

    assert.equal(a?.itemCode, b?.itemCode);
    assert.equal(a?.canonicalCode, b?.canonicalCode);
    assert.notEqual(a?.price, b?.price);
  });

  it('商品コードが違えば別の名寄せキーになる', () => {
    const other = parseInstoreCode('2100999004980');

    assert.notEqual(other?.canonicalCode, parseInstoreCode(PRICE_498)?.canonicalCode);
  });

  it('名寄せキー自体もチェックディジットの妥当なコードになる', () => {
    const info = parseInstoreCode(PRICE_498);

    assert.ok(info);
    assert.equal(info.canonicalCode.length, 13);
    assert.ok(hasValidCheckDigit(info.canonicalCode), info.canonicalCode);
  });

  it('通常のJANコードは解析対象外 (null)', () => {
    assert.equal(parseInstoreCode('4901777300446'), null);
  });

  it('桁数が合わないインストアコードは解析しない', () => {
    assert.equal(parseInstoreCode('21001230'), null);
  });

  it('レイアウトを空にすると解析を無効化できる', () => {
    assert.equal(parseInstoreCode(PRICE_498, []), null);
    assert.equal(toLookupKey(PRICE_498, []), PRICE_498);
  });

  it('重量レイアウトを指定すると重量として解釈する', () => {
    const info = parseInstoreCode(PRICE_498, [JP_WEIGHT_EMBEDDED_13]);

    assert.equal(info?.weight, 498);
    assert.equal(info?.price, null);
  });

  it('valueScale で最小単位を変えられる (0.1g単位 → g)', () => {
    const layout: InstoreCodeLayout = { ...JP_WEIGHT_EMBEDDED_13, valueScale: 0.1 };

    assert.equal(parseInstoreCode(PRICE_498, [layout])?.weight, 49.8);
  });

  it('桁割りを差し替えられる (商品コード6桁・価格4桁)', () => {
    const layout: InstoreCodeLayout = {
      name: 'CUSTOM_13',
      prefixes: ['21'],
      length: 13,
      itemCode: [2, 8],
      value: [8, 12],
      valueType: 'PRICE',
    };
    const info = parseInstoreCode(PRICE_498, [layout]);

    assert.equal(info?.itemCode, '001230');
    assert.equal(info?.price, 498);
  });

  it('buildCanonicalCode は価格部だけを 0 に潰す', () => {
    const canonical = buildCanonicalCode(PRICE_498, DEFAULT_INSTORE_LAYOUTS[0]!);

    assert.equal(canonical.slice(0, 7), '2100123');
    assert.equal(canonical.slice(7, 12), '00000');
  });
});

describe('resolveProduct とインストアコードの連携', () => {
  interface SetupOptions {
    mergeInstoreByItemCode?: boolean;
    instoreLayouts?: InstoreCodeLayout[];
  }

  function setup(options: SetupOptions = {}) {
    const productRepository = new InMemoryProductRepository();
    const searchClient = new StubSearchClient(async () => {
      throw new Error('インストアコードでAPIを呼んではいけない');
    });
    const resolver = createProductResolver({
      productRepository,
      searchClient,
      ...options,
    });
    return { resolver, productRepository, searchClient };
  }

  it('埋め込み価格・商品コードを解析結果として返す', async () => {
    const { resolver } = setup();

    const result = await resolver.resolveProduct(PRICE_498);

    assert.equal(result.status, ProductStatus.REQUIRES_MANUAL_INPUT);
    assert.equal(result.manualInputReason, ManualInputReason.INSTORE_CODE);
    assert.equal(result.instore?.price, 498, '価格フォームの初期値に使える');
    assert.equal(result.instore?.itemCode, '00123');
  });

  it('価格が変わっても同じ商品として解決する', async () => {
    const { resolver, productRepository } = setup();

    await resolver.resolveProduct(PRICE_498);
    const product = await resolver.registerManualProduct(PRICE_498, {
      name: '国産豚バラ肉',
    });

    // 翌週、値引きされて別のバーコードになった同じ商品をスキャンする。
    const again = await resolver.resolveProduct(PRICE_398);

    assert.equal(again.status, ProductStatus.RESOLVED);
    assert.equal(again.product.id, product.id, '同一商品として名寄せされる');
    assert.equal(again.instore?.price, 398, '今回の価格は 398 円');
    assert.equal(productRepository.size, 1, '価格ごとに商品が増えない');
  });

  it('mergeInstoreByItemCode: false なら従来どおりコードごとに別商品', async () => {
    const { resolver, productRepository } = setup({ mergeInstoreByItemCode: false });

    await resolver.registerManualProduct(PRICE_498, { name: '国産豚バラ肉' });
    const again = await resolver.resolveProduct(PRICE_398);

    assert.equal(again.status, ProductStatus.REQUIRES_MANUAL_INPUT);
    assert.equal(again.product.janCode, PRICE_398);
    assert.equal(productRepository.size, 1);
  });

  it('レイアウト無効化時は解析結果を返さない', async () => {
    const { resolver } = setup({ instoreLayouts: [] });

    const result = await resolver.resolveProduct(PRICE_498);

    assert.equal(result.instore, undefined);
    assert.equal(result.product.janCode, PRICE_498);
  });
});
