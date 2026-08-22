WITH weekly_periods AS (
  SELECT
    "id",
    to_char(
      "period_start" AT TIME ZONE 'Asia/Shanghai',
      'YYYY"年"FMMM"月"FMDD"日"'
    ) || '—' || to_char(
      ("period_end" - interval '1 millisecond') AT TIME ZONE 'Asia/Shanghai',
      'YYYY"年"FMMM"月"FMDD"日"'
    ) AS "period_label"
  FROM "reports"
  WHERE "kind" = 'weekly'
)
UPDATE "reports" AS report
SET
  "title" = '周报（' || weekly_periods."period_label" || '）',
  "summary" = regexp_replace(
    report."summary",
    '((1[0-2]|[1-9])月(上旬|中旬|下旬)|(本月|当月)(上旬|中旬|下旬))',
    weekly_periods."period_label",
    'g'
  ),
  "body_markdown" = CASE
    WHEN position(
      '> 报告周期：' || weekly_periods."period_label" IN report."body_markdown"
    ) > 0 THEN regexp_replace(
      report."body_markdown",
      '((1[0-2]|[1-9])月(上旬|中旬|下旬)|(本月|当月)(上旬|中旬|下旬))',
      weekly_periods."period_label",
      'g'
    )
    ELSE '> 报告周期：' || weekly_periods."period_label" || E'\n\n' || regexp_replace(
      report."body_markdown",
      '((1[0-2]|[1-9])月(上旬|中旬|下旬)|(本月|当月)(上旬|中旬|下旬))',
      weekly_periods."period_label",
      'g'
    )
  END
FROM weekly_periods
WHERE report."id" = weekly_periods."id";
