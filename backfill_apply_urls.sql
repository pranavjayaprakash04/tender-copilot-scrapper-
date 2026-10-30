-- Review the candidate tender-detail URLs before changing any rows.
SELECT
  tender_id,
  portal,
  title,
  url AS candidate_apply_url
FROM public.tenders
WHERE (apply_url IS NULL OR BTRIM(apply_url) = '')
  AND url ~* '^https?://'
  AND (
    url ~* '/showbidDocument/[0-9]+'
    OR url ~* 'DirectLink'
    OR url ~* '(viewTender|tenderdetails?|bid_id=|tender_id=|bidid=|tenderid=)'
  )
ORDER BY portal, tender_id
LIMIT 100;

-- Optional count of all rows the update below would fill.
SELECT COUNT(*) AS rows_to_fill
FROM public.tenders
WHERE (apply_url IS NULL OR BTRIM(apply_url) = '')
  AND url ~* '^https?://'
  AND (
    url ~* '/showbidDocument/[0-9]+'
    OR url ~* 'DirectLink'
    OR url ~* '(viewTender|tenderdetails?|bid_id=|tender_id=|bidid=|tenderid=)'
  );

-- Fill only empty apply_url values from known tender-specific URLs.
-- Existing real application URLs are not overwritten.
UPDATE public.tenders
SET apply_url = BTRIM(url)
WHERE (apply_url IS NULL OR BTRIM(apply_url) = '')
  AND url ~* '^https?://'
  AND (
    url ~* '/showbidDocument/[0-9]+'
    OR url ~* 'DirectLink'
    OR url ~* '(viewTender|tenderdetails?|bid_id=|tender_id=|bidid=|tenderid=)'
  );
