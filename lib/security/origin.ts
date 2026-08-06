export class OriginError extends Error {
  constructor() {
    super("Mutation request origin is not trusted");
    this.name = "OriginError";
  }
}

export function assertTrustedMutationOrigin(request: Request, trustedOrigin: string): void {
  if (request.headers.get("origin") !== trustedOrigin) {
    throw new OriginError();
  }
}
