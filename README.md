# dict-js

A small JavaScript library for reading dictd and StarDict dictionaries.

## Usage

```js
import { StarDict } from './dict.js'
import { inflate } from 'your inflate implementation'

const { ifo, dz, idx, syn } = { /* `File` (or `Blob`) objects */ }
const dict = new StarDict()
await dict.loadIfo(ifo)
await dict.loadDict(dz, inflate)
await dict.loadIdx(idx)
await dict.loadSyn(syn)

// look up words
const query = '...'
await dictionary.lookup(query)
await dictionary.synonyms(query)
```

Note that you must supply your own `inflate` function. Here is an example using [fflate](https://github.com/101arrowz/fflate):
```js
const inflate = data => new Promise(resolve => {
    const inflate = new fflate.Inflate()
    inflate.ondata = data => resolve(data)
    inflate.push(data)
})
```

## License

MIT.
