/** 金額計算まわりの小さなヘルパ。浮動小数の誤差で判定がブレるのを防ぐ。 */

const EPSILON = 1e-9;

/** 指定桁で四捨五入する。 */
export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** a < b (誤差を考慮)。 */
export function isLessThan(a: number, b: number): boolean {
  return a < b - EPSILON;
}

/** a <= b (誤差を考慮)。 */
export function isLessThanOrEqual(a: number, b: number): boolean {
  return a <= b + EPSILON;
}

/** a > b (誤差を考慮)。 */
export function isGreaterThan(a: number, b: number): boolean {
  return a > b + EPSILON;
}
