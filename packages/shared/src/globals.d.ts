// The two web globals this package relies on, present in every browser and in Node since 16: declared here rather
// than pulling in the whole DOM library, so nothing else from the DOM can creep in unnoticed.
declare function atob(data: string): string;
declare class TextDecoder {
  constructor(label?: string);
  decode(input?: Uint8Array): string;
}
