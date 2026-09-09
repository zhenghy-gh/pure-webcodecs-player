/**
 * AMF0 最小读取器（FLV onMetaData 所需子集）。
 * 支持：Number(0x00) Boolean(0x01) String(0x02) Object(0x03) Null(0x05)
 *       Undefined(0x06) ECMA Array(0x08)。其余标记跳过或抛解析错。
 */

export class AmfReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.strict = true;
  }

  get remaining() {
    return this.bytes.length - this.pos;
  }

  readValue() {
    const marker = this.#u8();
    switch (marker) {
      case 0x00:
        return this.#f64();
      case 0x01:
        return this.#u8() !== 0;
      case 0x02:
        return this.#utf(this.#u16());
      case 0x03:
        return this.#objectLike();
      case 0x05:
        return null;
      case 0x06:
        return undefined;
      case 0x08: {
        this.#u32(); // 声明的条目数不可靠，以结束标记为准
        return this.#objectLike();
      }
      default:
        throw new Error(`AMF0 未支持的标记: 0x${marker.toString(16)}@${this.pos - 1}`);
    }
  }

  /** 读取一个「方法名+参数」序列（script tag 用） */
  readCommand() {
    const name = this.readValue();
    const args = [];
    while (this.remaining > 0) {
      try {
        args.push(this.readValue());
      } catch {
        break;
      }
    }
    return { name, args };
  }

  #objectLike() {
    const out = {};
    for (;;) {
      if (this.remaining < 3) break;
      // 结束标记 00 00 09
      if (this.bytes[this.pos] === 0 && this.bytes[this.pos + 1] === 0 && this.bytes[this.pos + 2] === 9) {
        this.pos += 3;
        break;
      }
      const key = this.#utf(this.#u16());
      if (!key) break;
      out[key] = this.readValue();
    }
    return out;
  }

  #u8() {
    if (this.remaining < 1) throw new Error('AMF0 数据不足');
    return this.bytes[this.pos++];
  }

  #u16() {
    if (this.remaining < 2) throw new Error('AMF0 数据不足');
    const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
    this.pos += 2;
    return v;
  }

  #u32() {
    if (this.remaining < 4) throw new Error('AMF0 数据不足');
    let v = 0;
    for (let i = 0; i < 4; i++) v = v * 256 + this.bytes[this.pos + i];
    this.pos += 4;
    return v;
  }

  #f64() {
    if (this.remaining < 8) throw new Error('AMF0 数据不足');
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    for (let i = 0; i < 8; i++) view.setUint8(i, this.bytes[this.pos + i]);
    this.pos += 8;
    return view.getFloat64(0);
  }

  #utf(len) {
    if (this.remaining < len) throw new Error('AMF0 字符串越界');
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.bytes[this.pos + i]);
    this.pos += len;
    try {
      return decodeURIComponent(escape(s));
    } catch {
      return s;
    }
  }
}
