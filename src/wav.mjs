// wav.mjs —— 最小 wav 工具：读时长、估算下限、判断是否被截断。
//
// 为什么需要它：GPT-SoVITS 偶尔会提前掐断长句，但 HTTP 仍然返回 200。
// 光看状态码发现不了，只能用"音频时长 vs 文本长度"做个下限校验。

/** 读标准 PCM wav 的时长（秒）。非 wav / 结构异常返回 0。 */
export function wavSeconds(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 44) return 0;
    const byteRate = buf.readUInt32LE(28); // fmt chunk 的 byteRate
    const dataSize = buf.readUInt32LE(40); // data chunk 大小
    if (!byteRate || !dataSize) return 0;
    return dataSize / byteRate;
  } catch {
    return 0;
  }
}

/**
 * 按字数估算"这句话至少该有多长"（秒）。
 *
 * 中文语速约 4~5 字/秒，这里取保守下限（0.15s/字），只用来发现**明显**截断，
 * 不追求精确——精确的语速判断需要对齐模型，不值当。
 */
export function minExpectedSeconds(text) {
  const chars = String(text ?? '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').length;
  return Math.max(0.5, chars * 0.15);
}

/** 这算不算"疑似截断"。 */
export function looksTruncated(buf, text) {
  const seconds = wavSeconds(buf);
  if (!seconds) return false;
  return seconds < minExpectedSeconds(text);
}
