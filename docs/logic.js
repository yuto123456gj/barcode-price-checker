/* =====================================================================
 * 判定ロジック。src/utils/*.ts と src/core/evaluatePrice.ts の移植で、
 * しきい値・丸め・名寄せの規則は Node モジュール版と同じ。
 * ブラウザから直接読む想定なのでグローバル Logic に載せている。
 * ===================================================================== */

var Logic = (function () {
  'use strict';

  var GOOD_DEAL_RATIO = 0.95;
  var HIGH_RATIO = 1.05;
  var EPS = 1e-9;

  var LABELS = {
    LOWEST_EVER: '🎉 過去最安値を更新',
    GOOD_DEAL: '👍 お買い得',
    AVERAGE: '😐 いつもの値段',
    HIGH: '⚠️ 高め',
    FIRST_SCAN: '🆕 はじめての記録'
  };

  function round(value, digits) {
    var factor = Math.pow(10, digits === undefined ? 4 : digits);
    return Math.round(value * factor) / factor;
  }

  function normalizeCode(code) {
    return String(code || '').replace(/[\s-]/g, '');
  }

  function isValidBarcode(code) {
    var n = normalizeCode(code);
    return /^\d+$/.test(n) && (n.length === 8 || n.length === 12 || n.length === 13);
  }

  /** 先頭2桁が 20〜29 のインストアコード（店内採番・生鮮食品）か。 */
  function isInstoreCode(code) {
    var n = normalizeCode(code);
    if (n.length < 2 || !/^\d{2}/.test(n)) return false;
    var prefix = Number(n.slice(0, 2));
    return prefix >= 20 && prefix <= 29;
  }

  function computeCheckDigit(body) {
    var sum = String(body).split('').map(Number).reverse()
      .reduce(function (acc, digit, i) { return acc + digit * (i % 2 === 0 ? 3 : 1); }, 0);
    return (10 - (sum % 10)) % 10;
  }

  /* 価格埋め込み13桁: 2F | 商品コード5桁 | 価格5桁 | CD */
  var LAYOUT = { item: [2, 7], value: [7, 12], length: 13 };

  function parseInstoreCode(code) {
    var n = normalizeCode(code);
    if (!/^\d+$/.test(n) || !isInstoreCode(n) || n.length !== LAYOUT.length) return null;

    var masked = n.slice(0, LAYOUT.value[0]) + '00000' + n.slice(LAYOUT.value[1]);
    var body = masked.slice(0, -1);

    return {
      prefix: n.slice(0, 2),
      itemCode: n.slice(LAYOUT.item[0], LAYOUT.item[1]),
      price: Number(n.slice(LAYOUT.value[0], LAYOUT.value[1])),
      checkDigit: n.slice(12),
      canonicalCode: body + String(computeCheckDigit(body)),
      raw: n
    };
  }

  /**
   * 商品を照合するキー。価格埋め込みコードは値引きのたびに文字列が変わるので、
   * 埋め込み部を潰したコードで名寄せする。
   */
  function toLookupKey(code) {
    var n = normalizeCode(code);
    var parsed = parseInstoreCode(n);
    return parsed ? parsed.canonicalCode : n;
  }

  /**
   * 価格判定。history は [{price, qty, unit, store, at}]。
   * 容量があれば単価、なければ総額で比較する。
   */
  function evaluatePrice(history, currentPrice, currentQty) {
    var useUnit = currentQty !== null && currentQty !== undefined && currentQty > 0;
    var current = round(useUnit ? currentPrice / currentQty : currentPrice);

    var comparable = [];
    for (var i = 0; i < history.length; i++) {
      var entry = history[i];
      var metric;
      if (useUnit) {
        if (!entry.qty || entry.qty <= 0) continue;   // 500ml と 2L を混ぜない
        metric = entry.price / entry.qty;
      } else {
        metric = entry.price;
      }
      if (!isFinite(metric)) continue;
      comparable.push({ record: entry, metric: round(metric) });
    }

    if (comparable.length === 0) {
      return {
        status: 'FIRST_SCAN', current: current, lowest: null, average: null,
        diff: null, useUnit: useUnit, size: 0, lowestRecord: null
      };
    }

    var lowest = comparable.reduce(function (min, e) { return e.metric < min.metric ? e : min; });
    var sum = comparable.reduce(function (acc, e) { return acc + e.metric; }, 0);
    var average = round(sum / comparable.length);
    var diff = average === 0 ? 0 : round(((current - average) / average) * 100, 1);

    var status;
    if (current < lowest.metric - EPS) status = 'LOWEST_EVER';
    else if (current <= average * GOOD_DEAL_RATIO + EPS) status = 'GOOD_DEAL';
    else if (current > average * HIGH_RATIO + EPS) status = 'HIGH';
    else status = 'AVERAGE';

    return {
      status: status, current: current, lowest: lowest.metric, average: average,
      diff: diff, useUnit: useUnit, size: comparable.length, lowestRecord: lowest.record
    };
  }

  return {
    LABELS: LABELS,
    round: round,
    normalizeCode: normalizeCode,
    isValidBarcode: isValidBarcode,
    isInstoreCode: isInstoreCode,
    computeCheckDigit: computeCheckDigit,
    parseInstoreCode: parseInstoreCode,
    toLookupKey: toLookupKey,
    evaluatePrice: evaluatePrice
  };
})();
