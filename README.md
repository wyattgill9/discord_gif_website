# gif it

Drop an image or a video, get a GIF sized for Discord. Runs entirely in the browser —
no server, no upload, no build step.

**→ https://wyattgill9.github.io/discord_gif_website/**

```sh
bun run dev    # http://localhost:3000
bun test
```

The only dependency is [gifenc](https://github.com/mattdesl/gifenc), vendored as a single
9KB file in `vendor/`. Deploying is `git push`; GitHub Pages serves the repo root as-is.
