# Model Providers

OpenClick supports Anthropic and OpenAI for hosted planning, verification, result summaries, and compile flows.

Choose a provider and save its API key:

```sh
openclick settings provider set anthropic
openclick settings anthropic-api-key set sk-ant-...

openclick settings provider set openai
openclick settings openai-api-key set sk-...
```

`settings api-key` is kept as the Anthropic key shortcut:

```sh
openclick settings api-key status
openclick settings api-key set sk-ant-...
openclick settings api-key clear
```

Provider and model commands:

```sh
openclick settings provider status
openclick settings provider set anthropic
openclick settings provider set openai

openclick settings model status
openclick settings model set planner <model>
openclick settings model set verifier <model>
openclick settings model set result <model>
openclick settings model set compile <model>
```

Environment variables also work:

```sh
ANTHROPIC_API_KEY=sk-ant-... openclick run "..." --live
OPENAI_API_KEY=sk-... openclick run "..." --live
OPENCLICK_MODEL_PROVIDER=openai openclick run "..." --live
```

The default action loop remains optimized for hosted Anthropic/OpenAI models plus AX and `cua-driver` grounding. Local/open-model providers are planned behind the same abstraction, but should not reduce the default hosted-model accuracy.

