/** An error with the HTTP status the server stub answers it with. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string, name = "HttpError") {
    super(message);
    this.status = status;
    this.name = name;
  }
}

/** The JSON error body both stubs agree on. */
export function errorResponse(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: { name, message } }, { status });
}

/** The error a non-OK response carries, rebuilt on the client. */
export async function errorFromResponse(res: Response): Promise<Error> {
  let name = "HttpError";
  let message = `HTTP ${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as { error?: { name?: string; message?: string } };
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.name) name = body.error.name;
  } catch {
    // Not our JSON error body: keep the status line.
  }
  const error = new Error(message);
  error.name = name;
  return error;
}
