export default function handler(_req: unknown, res: { status: (n: number) => unknown }) {
  res.status(200);
}
