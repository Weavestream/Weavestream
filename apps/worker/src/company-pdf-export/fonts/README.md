# Vendored PDF fonts

The company PDF export embeds these two unmodified upstream font files:

- `NotoSansCJKjp-Regular.otf`
- `NotoSansCJKjp-Bold.otf`

Source: Noto Sans CJK 2.004, official `notofonts/noto-cjk` release

Release: https://github.com/notofonts/noto-cjk/releases/tag/Sans2.004

Archive: https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/06_NotoSansCJKjp.zip

Retrieved: 2026-07-23

SHA-256:

```text
68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5  NotoSansCJKjp-Regular.otf
e53dcb0dcb2922e45d01aae1ebd2f382bb81d4229b18b6b883bd170678af1f76  NotoSansCJKjp-Bold.otf
```

The files are licensed under the SIL Open Font License 1.1. See
`LICENSE-OFL-1.1.txt`. They are intentionally vendored instead of installed
through a font bundle package so the worker image contains only the faces it
uses.
