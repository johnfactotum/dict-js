const decoder = new TextDecoder()
const decode = decoder.decode.bind(decoder)

const concatTypedArray = (a, b) => {
    const result = new a.constructor(a.length + b.length)
    result.set(a)
    result.set(b, a.length)
    return result
}

const strcmp = (a, b) => {
    a = a.toLowerCase(), b = b.toLowerCase()
    return a < b ? -1 : a > b ? 1 : 0
}

class DictZip {
    #chlen
    #chunks
    #compressed
    inflate
    async load(file) {
        const header = new DataView(await file.slice(0, 12).arrayBuffer())
        if (header.getUint8(0) !== 31 || header.getUint8(1) !== 139
        || header.getUint8(2) !== 8) throw new Error('Not a DictZip file')
        const flg = header.getUint8(3)
        if (!flg & 0b100) throw new Error('Missing FEXTRA flag')

        const xlen = header.getUint16(10, true)
        const extra = new DataView(await file.slice(12, 12 + xlen).arrayBuffer())
        if (extra.getUint8(0) !== 82 || extra.getUint8(1) !== 65)
            throw new Error('Subfield ID should be RA')
        if (extra.getUint16(4, true) !== 1) throw new Error('Unsupported version')

        this.#chlen = extra.getUint16(6, true)
        const chcnt = extra.getUint16(8, true)
        this.#chunks = []
        for (let i = 0, chunkOffset = 0; i < chcnt; i++) {
            const chunkSize = extra.getUint16(10 + 2 * i, true)
            this.#chunks.push([chunkOffset, chunkSize])
            chunkOffset = chunkOffset + chunkSize
        }

        // skip to compressed data
        let offset = 12 + xlen
        const max = Math.min(offset + 512, file.size)
        const strArr = new Uint8Array(await file.slice(0, max).arrayBuffer())
        if (flg & 0b1000) { // fname
            const i = strArr.indexOf(0, offset)
            if (i < 0) throw new Error('Header too long')
            offset = i + 1
        }
        if (flg & 0b10000) { // fcomment
            const i = strArr.indexOf(0, offset)
            if (i < 0) throw new Error('Header too long')
            offset = i + 1
        }
        if (flg & 0b10) offset += 2 // fhcrc
        this.#compressed = file.slice(offset)
    }
    async read(offset, size) {
        const chunks = this.#chunks
        const startIndex = Math.trunc(offset / this.#chlen)
        const endIndex = Math.trunc((offset + size) / this.#chlen)
        const buf = await this.#compressed.slice(chunks[startIndex][0],
            chunks[endIndex][0] + chunks[endIndex][1]).arrayBuffer()
        let arr = new Uint8Array()
        for (let pos = 0, i = startIndex; i <= endIndex; i++) {
            const data = new Uint8Array(buf, pos, chunks[i][1])
            arr = concatTypedArray(arr, await this.inflate(data))
            pos += chunks[i][1]
        }
        const startOffset = offset - startIndex * this.#chlen
        return arr.subarray(startOffset, startOffset + size)
    }
}

class Index {
    strcmp = strcmp
    // binary search
    bisect(query, start = 0, end = this.idx.length) {
        if (end - start === 1) {
            if (query === this.idx[start][0]) return start
            if (query === this.idx[end][0]) return end
            return null
        }
        const mid = Math.floor(start + (end - start) / 2)
        const word = this.idx[mid][0]
        const cmp = this.strcmp(query, word)
        if (cmp === -1) return this.bisect(query, start, mid)
        if (cmp === 1) return this.bisect(query, mid, end)
        return mid
    }
    // check for multiple definitions
    checkAdjacent(query, i) {
        if (i == null) return []
        let j = i
        while (!this.strcmp(query, this.idx[j - 1]?.[0])) j--
        let k = i
        while (!this.strcmp(query, this.idx[k + 1]?.[0])) k++
        return j === k ? [this.idx[i]] : this.idx.slice(j, k + 1)
    }
    lookup(query) {
        if (!this.idx) return []
        return this.checkAdjacent(query, this.bisect(query))
    }
}

const decodeBase64Number = str => {
    const { length } = str
    let n = 0
    for (let i = 0; i < length; i++) {
        const c = str.charCodeAt(i)
        n += (c === 43 ? 62     // "+"
            : c === 47 ? 63     // "/"
            : c < 58 ? c + 4    // 0-9 -> 52-61
            : c < 91 ? c - 65   // A-Z -> 0-25
            : c - 71            // a-z -> 26-51
        ) * 64 ** (length - 1 - i)
    }
    return n
}

class DictdIndex extends Index {
    async load(file) {
        this.idx = decode(await file.arrayBuffer()).split('\n').map(line => {
            const arr = line.split('\t')
            arr[1] = decodeBase64Number(arr[1])
            arr[2] = decodeBase64Number(arr[2])
            return arr
        })
    }
}

export class DictdDict {
    #dict = new DictZip()
    #idx = new DictdIndex()
    loadDict(file, inflate) {
        this.#dict.inflate = inflate
        return this.#dict.load(file)
    }
    #readWord([word, offset, size]) {
        return { word, data: ['m', this.#dict.read(offset, size)] }
    }
    #readWords(arr) {
        return Promise.all(arr.map(this.#readWord.bind(this)))
    }
    lookup(query) {
        return this.#readWords(this.#idx.lookup(query))
    }
}

class StarDictIndex extends Index {
    isSyn
    async load(file) {
        const { isSyn } = this
        const buf = await file.arrayBuffer()
        const arr = new Uint8Array(buf)
        const view = new DataView(buf)
        const idx = []
        for (let i = 0; i < arr.length;) {
            const newI = arr.subarray(0, i + 256).indexOf(0, i)
            if (newI < 0) throw new Error('Word too big')
            const word = decode(arr.subarray(i, newI))
            const off = view.getUint32(newI + 1)
            idx.push(isSyn ? [word, off] : [word, off, view.getUint32(newI + 5)])
            i = newI + (isSyn ? 5 : 9)
        }
        this.idx = idx
    }
}

export class StarDict {
    #dict = new DictZip()
    #idx = new StarDictIndex()
    #syn = Object.assign(new StarDictIndex(), { isSyn: true })
    async loadIfo(file) {
        const str = decode(await file.arrayBuffer())
        this.ifo = Object.fromEntries(str.split('\n').map(line => {
            const sep = line.indexOf('=')
            if (sep < 0) return
            return [line.slice(0, sep), line.slice(sep + 1)]
        }).filter(x => x))
    }
    loadDict(file, inflate) {
        this.#dict.inflate = inflate
        return this.#dict.load(file)
    }
    loadIdx(file) {
        return this.#idx.load(file)
    }
    loadSyn(file) {
        if (file) return this.#syn.load(file)
    }
    async #readWord([word, offset, size]) {
        const data = await this.#dict.read(offset, size)
        const seq = this.ifo.sametypesequence
        if (!seq) throw new Error('TODO')
        if (seq.length === 1) return { word, data: [[seq[0], data]] }
        throw new Error('TODO')
    }
    #readWords(arr) {
        return Promise.all(arr.map(this.#readWord.bind(this)))
    }
    lookup(query) {
        return this.#readWords(this.#idx.lookup(query))
    }
    synonyms(query) {
        return this.#readWords(this.#syn.lookup(query).map(s => this.#idx.idx[s[1]]))
    }
}
