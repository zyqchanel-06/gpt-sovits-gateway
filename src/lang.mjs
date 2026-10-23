// lang.mjs —— 语言判定。
//
// 为什么不交给自动检测库：fast_langdetect 之类的小模型经常把中文判成日语，
// 结果就是"中文文本用日语前端读"，出来的音非常怪。规则判定反而稳。

const KANA = /[\u3040-\u309F\u30A0-\u30FF]/; // 平假名 / 片假名

/**
 * 决定 text_lang 参数。
 *
 * @param {string} text        要合成的文本
 * @param {string} [configured] 配置里的语言；留空或 'auto' 时按规则判断
 * @returns {string} GPT-SoVITS 的语言码（zh / ja / en / ko / yue ...）
 */
export function pickTextLang(text, configured) {
  const value = String(configured ?? '').trim();
  if (value && value.toLowerCase() !== 'auto') return value;
  return KANA.test(String(text ?? '')) ? 'ja' : 'zh';
}
