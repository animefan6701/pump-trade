import { AnalyzeCoin } from "@/components/AnalyzeCoin";

export default async function Page({
  params,
}: {
  params: Promise<{ mint: string }>;
}) {
  const { mint } = await params;
  return <AnalyzeCoin mint={mint} />;
}
