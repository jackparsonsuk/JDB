import { crc32, deflateRawSync } from 'node:zlib'

/** Builds a deflated zip, enough for an .xlsx. Timestamps are fixed at 1980-01-01, which Excel doesn't read. */
export function zip(entries: { path: string; data: Buffer }[]): Buffer {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1
  const UTF8 = 0x0800
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const compressed = deflateRawSync(entry.data)
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + compressed.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
