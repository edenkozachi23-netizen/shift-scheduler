import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return NextResponse.json({ error: "Missing Supabase env vars" }, { status: 500 });
  }

  const res = await fetch(
    `${url}/rest/v1/shift_types?select=id,name,period,start_time,end_time`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );

  const body = await res.text();
  if (!res.ok) {
    return NextResponse.json({ error: `Supabase error ${res.status}: ${body}` }, { status: res.status });
  }

  return NextResponse.json(JSON.parse(body));
}
