
CREATE TABLE public.founders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  one_liner TEXT NOT NULL,
  track TEXT NOT NULL,
  stage TEXT NOT NULL,
  geo TEXT NOT NULL,
  sector TEXT NOT NULL,
  accelerator TEXT,
  prior_vc BOOLEAN NOT NULL DEFAULT false,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  founder_score JSONB NOT NULL,
  axes JSONB NOT NULL,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  claims JSONB NOT NULL DEFAULT '[]'::jsonb,
  gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  momentum JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.founders TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.founders TO authenticated;
GRANT ALL ON public.founders TO service_role;

ALTER TABLE public.founders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Founders are publicly readable"
ON public.founders FOR SELECT
TO anon, authenticated
USING (true);

INSERT INTO public.founders (id, name, company, one_liner, track, stage, geo, sector, accelerator, prior_vc, tags, founder_score, axes, signals, claims, gaps, momentum, sort_order) VALUES
('F-0142', 'Amara Diallo', 'Lattice Labs', 'Fine-tuning eval harness for regulated industries', 'inbound', 'Pre-seed', 'Lagos / remote', 'AI infra', NULL, false,
 '["cold-start","student","no funding history"]'::jsonb,
 '{"value":588,"low":471,"high":705,"trend":"improving","coldStart":true}'::jsonb,
 '{"founder":{"score":7.4,"trend":"improving","note":"No employment or funding record. Score built from public footprint: 3 hackathon podiums in 9 months, 41 technical blog posts, Kaggle top 2%."},"market":{"score":6.8,"rating":"bullish","trend":"stable","note":"Eval tooling for compliance-heavy verticals; early but pulled by regulation."},"ideaVsMarket":{"score":6.1,"trend":"improving","note":"Wedge is narrow but survives scrutiny; expansion path credible."}}'::jsonb,
 '[{"id":"S-311","src":"Hackathon","ts":"2026-07-04","text":"1st place, ETH Global Lagos — judged demo of eval harness v0","conf":0.95},{"id":"S-298","src":"Blog/RSS","ts":"2026-06-20","text":"Series of 8 posts on eval drift; 12k cumulative reads (public analytics)","conf":0.8},{"id":"S-276","src":"Kaggle","ts":"2026-05-30","text":"Top 2% finish, LLM-eval competition","conf":0.95}]'::jsonb,
 '[{"claim":"3 pilot conversations with fintech compliance teams","trust":0.55,"evidence":"Self-reported in application; one confirmed via public LinkedIn post by pilot lead (S-311 adjacent).","flag":null},{"claim":"Working prototype, 40 eval templates","trust":0.9,"evidence":"Public repo inspected: 43 templates, CI green, 212 commits over 5 months.","flag":null}]'::jsonb,
 '["Cap table: not disclosed","Financials: pre-revenue, no P&L exists"]'::jsonb,
 '[410,445,470,502,531,560,588]'::jsonb, 1),

('F-0117', 'Jonas Weber', 'Kernelframe', 'GPU scheduling layer for multi-tenant inference', 'inbound', 'Pre-seed', 'Berlin', 'AI infra', 'Top-tier (TechStars ''25)', false,
 '["technical founder","enterprise pilot","no prior VC"]'::jsonb,
 '{"value":742,"low":688,"high":796,"trend":"improving","coldStart":false}'::jsonb,
 '{"founder":{"score":8.6,"trend":"improving","note":"Ex-SAP infra, 6 yrs; maintainer of a 2.1k-star scheduler OSS project."},"market":{"score":8.1,"rating":"bullish","trend":"improving","note":"Inference cost pressure is acute; buyers already spending."},"ideaVsMarket":{"score":7.9,"trend":"stable","note":"Idea survives scrutiny as-is; defensibility from workload data."}}'::jsonb,
 '[{"id":"S-402","src":"GitHub","ts":"2026-07-11","text":"Commit velocity 3.2× 90-day baseline; 2 external enterprise contributors appeared","conf":0.9},{"id":"S-390","src":"Accelerator","ts":"2026-06-28","text":"TechStars ''25 cohort list (public page)","conf":0.95},{"id":"S-371","src":"HN","ts":"2026-06-12","text":"Show HN, 340 points; multiple infra leads asking for enterprise licensing","conf":0.85}]'::jsonb,
 '[{"claim":"Paid enterprise pilot with EU logistics firm, €8k/mo","trust":0.75,"evidence":"Pilot firm''s engineering blog references the tool by name (S-402); amount self-reported.","flag":null},{"claim":"Sole IP ownership, clean of prior-employer claims","trust":0.6,"evidence":"Self-attested; SAP IP release letter not yet sighted.","flag":null}]'::jsonb,
 '["Cap table: not disclosed","Customer references: one, pending call"]'::jsonb,
 '[640,655,668,690,705,726,742]'::jsonb, 2),

('F-0093', 'Riya Kapoor', 'Stitchpoint', 'Agentic QA for e-commerce catalog data', 'inbound', 'Seed', 'SF Bay Area', 'Applied AI', NULL, true,
 '["repeat founder","prior shutdown — score persisted"]'::jsonb,
 '{"value":701,"low":654,"high":748,"trend":"improving","coldStart":false,"history":"Score carried from prior venture Loomcart (2023–25, wound down). Shipped, hired 6, returned 40% of capital. Never reset."}'::jsonb,
 '{"founder":{"score":8.2,"trend":"improving","note":"Second-time founder; prior wind-down handled cleanly — treated as evidence of judgment, not failure."},"market":{"score":7.0,"rating":"neutral","trend":"stable","note":"Crowded; wedge is the agentic remediation loop, not detection."},"ideaVsMarket":{"score":7.2,"trend":"improving","note":"Early usage suggests the wedge holds."}}'::jsonb,
 '[{"id":"S-355","src":"ProductHunt","ts":"2026-07-01","text":"#3 product of the day; 61% of upvoters are verified e-comm operators","conf":0.85},{"id":"S-347","src":"Memory","ts":"2025-11-14","text":"Prior application (Loomcart) — diligence record retained in Memory layer","conf":1.0}]'::jsonb,
 '[{"claim":"$9k MRR, 14 paying stores","trust":0.8,"evidence":"Stripe dashboard screen-shared in intake call; store count cross-checked against public integrations page.","flag":null}]'::jsonb,
 '["Financial projections: founder declined to provide at this stage"]'::jsonb,
 '[612,598,605,630,655,680,701]'::jsonb, 3),

('F-0128', 'Derek Chen', 'Voxelane', 'Voice agents for property management', 'inbound', 'Pre-seed', 'Austin', 'Applied AI', NULL, false,
 '["⚠ contradiction flagged"]'::jsonb,
 '{"value":512,"low":430,"high":594,"trend":"declining","coldStart":false}'::jsonb,
 '{"founder":{"score":6.0,"trend":"declining","note":"Solid sales background; technical depth thin, no technical co-founder."},"market":{"score":7.4,"rating":"bullish","trend":"stable","note":"Real spend, clear buyer."},"ideaVsMarket":{"score":5.2,"trend":"declining","note":"Undifferentiated vs. 4 funded competitors; pivot capacity unclear."}}'::jsonb,
 '[{"id":"S-366","src":"Web","ts":"2026-07-09","text":"Site traffic est. ~2.1k/mo; app-store listing shows <500 installs","conf":0.7}]'::jsonb,
 '[{"claim":"$40k MRR claimed in deck (slide 7)","trust":0.25,"evidence":"CONTRADICTION: install base and traffic (S-366) imply revenue an order of magnitude lower. Validator Agent estimate: $3–6k MRR. Escalated before reaching investor.","flag":"contradiction"}]'::jsonb,
 '["Revenue verification: requested, not yet provided"]'::jsonb,
 '[560,566,558,549,540,528,512]'::jsonb, 4),

('F-0104', 'Sofia Marino', 'Tessella Bio', 'LLM copilot for wet-lab protocol design', 'inbound', 'Pre-seed', 'Boston', 'AI x Bio', 'Top-tier (YC W26)', false,
 '["axes disagree — do not average"]'::jsonb,
 '{"value":668,"low":610,"high":726,"trend":"stable","coldStart":false}'::jsonb,
 '{"founder":{"score":8.8,"trend":"stable","note":"PhD MIT bio + 3 yrs ML platform work. Rare dual profile."},"market":{"score":8.3,"rating":"bullish","trend":"improving","note":"Lab automation budgets expanding fast."},"ideaVsMarket":{"score":4.6,"trend":"declining","note":"Current idea does NOT survive scrutiny — protocol liability blocks adoption. Team almost certainly strong enough to pivot. This disagreement is the decision."}}'::jsonb,
 '[{"id":"S-338","src":"arXiv","ts":"2026-06-18","text":"First-author paper, 47 citations in 4 weeks","conf":0.95},{"id":"S-329","src":"Accelerator","ts":"2026-06-02","text":"YC W26 public batch page","conf":0.95}]'::jsonb,
 '[{"claim":"2 university lab LOIs","trust":0.7,"evidence":"One LOI sighted (PDF, signed); second self-reported.","flag":null}]'::jsonb,
 '["Traction: pre-product; usage metrics do not exist yet"]'::jsonb,
 '[660,665,671,674,670,669,668]'::jsonb, 5),

('F-0151', 'Ben Osei', '(unnamed — pre-application)', 'Compiler-level LLM inference optimization (inferred from repo)', 'outbound', 'Pre-seed', 'London', 'AI infra', NULL, false,
 '["outbound-sourced","not yet applied"]'::jsonb,
 '{"value":645,"low":540,"high":750,"trend":"improving","coldStart":true}'::jsonb,
 '{"founder":{"score":7.8,"trend":"improving","note":"Scored identically to inbound (brief §5). Signal-only profile; interval wide until application converges."},"market":{"score":7.6,"rating":"bullish","trend":"improving","note":"Inferred from repo direction."},"ideaVsMarket":{"score":null,"trend":null,"note":"Unscorable pre-application — flagged, not guessed."}}'::jsonb,
 '[{"id":"S-419","src":"GitHub","ts":"2026-07-15","text":"New repo: 890 stars in 11 days; commit pattern shows full-time effort began ~6 wks ago","conf":0.9},{"id":"S-421","src":"arXiv","ts":"2026-07-16","text":"Co-authored kernel-fusion paper, Cambridge affiliation","conf":0.95}]'::jsonb,
 '[]'::jsonb,
 '["No application yet — Activate to trigger one (cold outreach, not cold investment)"]'::jsonb,
 '[480,500,525,548,580,615,645]'::jsonb, 6);
