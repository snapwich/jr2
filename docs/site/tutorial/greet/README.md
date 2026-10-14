# greet

Says hello.

```sh
node bin/greet.js           # hello, world
node bin/greet.js ada       # hello, ada
node bin/greet.js --shout   # HELLO, WORLD!
```

No dependencies. The flags are parsed by hand in `src/greet.js`, and `bin/greet.js` prints what it returns.

```sh
npm test
```
