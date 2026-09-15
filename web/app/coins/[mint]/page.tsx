import { CoinDesk } from "@/components/CoinDesk";

export default async function Page({
  params,
}: {
  params: Promise<{ mint: string }>;
}) {
  const { mint } = await params;
  return <CoinDesk mint={mint} />;
}
