import { labstackWorkerQuery } from "@/lib/db/labstack";
async function main() {
  const r = await labstackWorkerQuery<any>(`
    SELECT ("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date AS day,
           COUNT(*)::int AS n, MAX(id) AS max_id
      FROM public."Order" WHERE "labId"=378 AND "appointmentTime" IS NOT NULL
       AND ("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
           >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 4
     GROUP BY 1 ORDER BY 1`);
  console.table(r);
  const mx = await labstackWorkerQuery<any>(`SELECT MAX(id) AS max FROM public."Order"`);
  console.log("highest order id overall:", mx[0].max);
}
main().catch(e=>{console.error(e);process.exit(1);});
