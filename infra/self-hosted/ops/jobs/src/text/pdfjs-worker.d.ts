// PDF.js ships its worker module without types; extraction loads it in this
// process so that PDF.js never starts a worker or fetches one.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
