# AWS Bedrock Integration

AWS Bedrock provides Claude models through AWS APIs, offering an alternative to the direct Anthropic API when hitting billing or usage limits.

## Setup

Add to `.env`:

```bash
AWS_BEDROCK_KEY=your-aws-access-key-id
AWS_BEDROCK_SECRET=your-aws-secret-access-key
AWS_BEDROCK_REGION=us-east-1
```

Or use your existing AWS credentials:
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` work as fallbacks
- `AWS_DEFAULT_REGION` is the fallback region

## Enabling Bedrock

**Option 1: Via Dashboard**
1. Open http://127.0.0.1:8790
2. Go to Settings tab
3. Set "Claude Backend" to "bedrock"
4. Save

**Option 2: Via settings.json**

Edit `.data/settings.json`:

```json
{
  "claude": {
    "backend": "bedrock"
  }
}
```

## How It Works

- Bedrock provides Claude 3.5 Sonnet, Claude 3.5 Haiku, and Claude 3 Opus
- Model IDs are mapped automatically (e.g., `claude-sonnet-5-5` → `anthropic.claude-3-5-sonnet-20241022-v2:0`)
- Pricing is typically lower than direct API
- Uses AWS billing (billed per token to your AWS account)
- Supports vision (images), JSON schema output
- Does **not** support:
  - Streaming (uses synchronous calls)
  - Effort levels (Bedrock doesn't have this)
  - Server-side fallbacks
  - Prompt caching (different from Anthropic API)

## Fallback Chain

When `studio` needs Claude:

1. **Gen first:** Uses `llm.json` / `llm.text` tools
   - Routes based on `settings.claude.backend`:
     - `"api"` → Direct Anthropic API (needs ANTHROPIC_API_KEY)
     - `"bedrock"` → AWS Bedrock (needs AWS credentials)
     - `"max-plan"` → Claude Code on J's Max plan (default)
2. **Claude Code fallback:** If Gen fails with billing error, Studio falls back to Claude Code

## Testing

```bash
# Check if configured
hawkesgen.cmd run llm.text --project test --param prompt="Say hello" --param model="claude-sonnet-5-5"

# Force Bedrock via settings
echo '{"claude":{"backend":"bedrock"}}' > .data/settings.json
npm run typecheck
npm test
```

## Regions and Availability

Bedrock Claude models are available in:
- `us-east-1` (N. Virginia)
- `us-west-2` (Oregon)
- `eu-central-1` (Frankfurt)
- `ap-southeast-1` (Singapore)
- And others (check AWS Bedrock console)

Model availability varies by region. If a model isn't available, you'll get a clear error message.

## Pricing

Bedrock Claude pricing (per million tokens, approximate):
- Claude 3 Opus: $15 input / $75 output
- Claude 3.5 Sonnet: $3 input / $15 output  
- Claude 3.5 Haiku: $0.80 input / $4 output

Compare to direct Anthropic API:
- Opus 5.5: $4 input / $20 output
- Sonnet 5.5: $2 input / $10 output
- Haiku 5.5: $0.10 input / $0.50 output

**Note:** Bedrock has different models/versions, but both are billed per token. Check your AWS Billing console for exact costs.

## Troubleshooting

**"AWS_BEDROCK_KEY and AWS_BEDROCK_SECRET are needed"**
- Add both keys to `.env` (not just AWS_BEDROCK_KEY)
- Or use AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY

**"Bedrock model not available in this region"**
- Try a different region (us-east-1 usually has all models)
- Check AWS Bedrock console → Model access

**"ThrottlingException"**
- Bedrock rate limited
- Wait a minute and retry
- Or switch back to `"max-plan"` temporarily

**"AccessDeniedException"**
- Your AWS credentials don't have Bedrock permissions
- Add IAM policy: `bedrock:InvokeModel` on resource `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`
