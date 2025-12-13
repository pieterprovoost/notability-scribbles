// Type declarations for plist module
declare module 'plist' {
    export function parse(xml: string | Buffer): any;
    export function build(obj: any): string;
}
