# The demo video

`web/static/video/spyglass-demo.mp4` (the docs home page and the demo page) is
cut from one continuous take of the demo.

```sh
# 1. The demo, with a distri key so the analyst can build a report
pnpm --filter @spyglass/demo dev                       # http://127.0.0.1:5198

# 2. Record: one take, the step marks, and the brand mark (needs Playwright)
node demo/video/record.mjs ~/spyglass-shots/video/raw

# 3. Compose: title card, captioned clips, end card, music (needs ffmpeg + Inter)
python3 demo/video/compose.py demo/video/video.json
cp ~/spyglass-shots/video/spyglass-demo.mp4 web/static/video/
```

`record.mjs` writes `take.webm`, `marks.json` (seconds where each step starts)
and `mark.png`. Each clip in `video.json` is a span between two marks, with an
optional offset and `speed` (the analyst's thinking time plays at 3x), and its
caption is burned in under the frame. Change a caption or a cut in
`video.json` and re-run step 3; only a new take needs step 2.

Music: "Dminor (90bpm)" by Pax11, CC0,
https://freesound.org/s/443454/. The file is not in this repo; point
`music.file` at your copy.
