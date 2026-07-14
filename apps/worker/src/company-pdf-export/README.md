# Company PDF export inspection fixture

The PDF builder spec contains a deterministic, non-secret company reconstruction fixture. From the repository root, generate it and render every page with Poppler:

```bash
mkdir -p tmp/pdfs
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" \
  WEAVESTREAM_PDF_FIXTURE_OUTPUT=tmp/pdfs/task-10-reconstruction-fixture.pdf \
  pnpm --filter @weavestream/worker test -- --runInBand \
  src/company-pdf-export/pdf-builder.spec.ts \
  -t 'builds a deterministic inspection fixture'
pdfinfo tmp/pdfs/task-10-reconstruction-fixture.pdf
pdftotext -layout \
  tmp/pdfs/task-10-reconstruction-fixture.pdf \
  tmp/pdfs/task-10-reconstruction-fixture.txt
pdftoppm -png -r 144 \
  tmp/pdfs/task-10-reconstruction-fixture.pdf \
  tmp/pdfs/task-10-page
```

Inspect every `tmp/pdfs/task-10-page-*.png`, then remove all fixture artifacts:

```bash
rm -f tmp/pdfs/task-10-reconstruction-fixture.pdf \
  tmp/pdfs/task-10-reconstruction-fixture.txt \
  tmp/pdfs/task-10-page-*.png
rmdir tmp/pdfs tmp 2>/dev/null || true
```
