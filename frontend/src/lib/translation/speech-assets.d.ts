declare module "coherent-piper-module" {
  export function createPiperPhonemize(options: {
    print(data: string): void;
    printErr(data: string): void;
    locateFile(path: string): string;
    getPreloadedPackage(): ArrayBuffer;
  }): Promise<{ callMain(args: string[]): void }>;
}
