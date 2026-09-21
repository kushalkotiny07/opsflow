import { labstackWorkerQuery } from "@/lib/db/labstack";
async function main() {
  const r = await labstackWorkerQuery<any>(`
    SELECT ("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
           COUNT(*)::int AS n
      FROM public."Order" WHERE "labId"=378 AND "appointmentTime" IS NOT NULL
       AND ("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
           BETWEEN (now() AT TIME ZONE 'Asia/Kolkata')::date - 4 AND (now() AT TIME ZONE 'Asia/Kolkata')::date + 2
     GROUP BY 1 ORDER BY 1`);
  console.log("lab 378 orders by local day:", r.length ? r : "(none in window)");
  const mx = await labstackWorkerQuery<any>(`SELECT MAX(id)::int AS max FROM public."Order"`);
  console.log("highest order id:", mx[0].max);
  const users = await labstackWorkerQuery<any>(`SELECT id,name FROM public."User" ORDER BY id LIMIT 8`);
  console.log("users available:", users.map((u:any)=>`${u.id}:${u.name}`).join(" | "));
}
main().catch(e=>{console.error(e.message);process.exit(1);});
