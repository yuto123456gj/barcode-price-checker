import {
  InstoreValueType,
  type InstoreCodeInfo,
  type InstoreCodeLayout,
} from '../types.ts';
import { computeCheckDigit, isInstoreCode, normalizeCode } from './janCode.ts';
import { round } from './number.ts';

/**
 * インストアコードに埋め込まれた価格・重量を取り出す。
 *
 * 日本の生鮮食品でよく使われる13桁の構成:
 *
 *   2 F | I I I I I | P P P P P | C
 *   └2桁┘ └─商品コード─┘ └─価格/重量─┘ └チェックディジット
 *
 * 桁割りはチェーンごとに異なるため {@link InstoreCodeLayout} で設定可能にしている。
 */

/** 価格埋め込み (13桁)。国内で最も一般的な構成。 */
export const JP_PRICE_EMBEDDED_13: InstoreCodeLayout = {
  name: 'JP_PRICE_EMBEDDED_13',
  prefixes: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'],
  length: 13,
  itemCode: [2, 7],
  value: [7, 12],
  valueType: InstoreValueType.PRICE,
};

/** 重量埋め込み (13桁)。量り売りで使われる。価格埋め込みと桁割りは同じ。 */
export const JP_WEIGHT_EMBEDDED_13: InstoreCodeLayout = {
  name: 'JP_WEIGHT_EMBEDDED_13',
  prefixes: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'],
  length: 13,
  itemCode: [2, 7],
  value: [7, 12],
  valueType: InstoreValueType.WEIGHT,
};

/**
 * 既定のレイアウト。価格埋め込みのみ有効にしている。
 *
 * 重量埋め込みは桁割りが価格埋め込みと同一で機械的に区別できないため、
 * 採用する場合は利用側が prefixes を絞って明示的に渡すこと。
 */
export const DEFAULT_INSTORE_LAYOUTS: InstoreCodeLayout[] = [JP_PRICE_EMBEDDED_13];

function slice(code: string, range: readonly [number, number]): string {
  return code.slice(range[0], range[1]);
}

/** レイアウトが指定のコードに適用できるか。 */
function matches(code: string, layout: InstoreCodeLayout): boolean {
  return (
    code.length === layout.length && layout.prefixes.includes(code.slice(0, 2))
  );
}

/**
 * インストアコードを解析する。
 *
 * @returns 一致するレイアウトがなければ null (= 埋め込み値なしとして扱う)
 */
export function parseInstoreCode(
  code: string,
  layouts: InstoreCodeLayout[] = DEFAULT_INSTORE_LAYOUTS,
): InstoreCodeInfo | null {
  const normalized = normalizeCode(code);
  if (!/^\d+$/.test(normalized) || !isInstoreCode(normalized)) return null;

  const layout = layouts.find((candidate) => matches(normalized, candidate));
  if (!layout) return null;

  const rawValue = slice(normalized, layout.value);
  if (!/^\d+$/.test(rawValue)) return null;

  // 0.1 のようなスケールを掛けると 498 * 0.1 = 49.800000000000004 になるため丸める。
  const value = round(Number(rawValue) * (layout.valueScale ?? 1));

  return {
    layoutName: layout.name,
    prefix: normalized.slice(0, 2),
    itemCode: slice(normalized, layout.itemCode),
    price: layout.valueType === InstoreValueType.PRICE ? value : null,
    weight: layout.valueType === InstoreValueType.WEIGHT ? value : null,
    quantity: layout.valueType === InstoreValueType.QUANTITY ? value : null,
    canonicalCode: buildCanonicalCode(normalized, layout),
    raw: normalized,
  };
}

/**
 * 埋め込み値を 0 で潰した「同一商品を指すコード」を作る。
 * 末尾はチェックディジットとして振り直すので、結果もそれ自体が妥当なコードになる。
 *
 * 例: 2100123 04980 1 (498円) → 2100123 00000 x
 *     価格が変わっても同じキーになるため、価格履歴が1商品に積み上がる。
 */
export function buildCanonicalCode(code: string, layout: InstoreCodeLayout): string {
  const [valueStart, valueEnd] = layout.value;
  const masked =
    code.slice(0, valueStart) + '0'.repeat(valueEnd - valueStart) + code.slice(valueEnd);
  const body = masked.slice(0, -1);
  return body + String(computeCheckDigit(body));
}

/**
 * 商品を照合するためのキーを返す。
 *
 * 価格埋め込みのインストアコードは「スキャンのたびに値が変わる」ため、
 * バーコード文字列そのものを商品IDの代わりに使うと、価格改定のたびに
 * 別商品として登録されてしまう。埋め込み部を潰したキーで名寄せする。
 */
export function toLookupKey(
  code: string,
  layouts: InstoreCodeLayout[] = DEFAULT_INSTORE_LAYOUTS,
): string {
  const normalized = normalizeCode(code);
  return parseInstoreCode(normalized, layouts)?.canonicalCode ?? normalized;
}
