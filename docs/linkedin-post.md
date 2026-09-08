I built an AI system to find problem patterns in bank complaints.

The best decision I made was keeping the AI out of the decision.

Five rules it runs on:

1. **Unplug test.** Statistics find the anomalies, not the model. Switch the AI off and the system still produces correct, ranked alerts. If unplugging your model leaves you with nothing, you didn't build a system — you built a wrapper around a guess.

2. **Sealed envelope.** The model sees 15 complaints and six numbers. No internet, no database, no memory. If a fact isn't in the envelope, it cannot reach it.

3. **Receipts, checked by code.** Every factual sentence must cite the complaint it came from — and separate code verifies each one. Invented number, missing citation, or a prediction about regulators, and the whole write-up is binned. *Asking a model not to make things up is not the same as checking that it didn't.*

4. **Human first, AI second.** The analyst commits to their judgement before the server will reveal what the model proposed. Show the AI's answer first and you're no longer measuring agreement — you're measuring anchoring.

5. **No hiding behind averages.** A model that improves overall while collapsing on one product is a regression. It ships only if it clears the bar in every segment.

The catch that proves the point: in the first live run, every single passing write-up proposed the same severity — "medium." A model that always says "medium" scores respectably against any label set where medium is common, while being completely useless.

An average would have called that a success. The segments called it what it was.

Cost: $0.0019 per case. Runs on a free tier. Built on public CFPB complaint data.

The score it produces is a **priority**, not a prediction. It says "look at this first." That's all it claims — and that's the whole discipline.

#AI #GenAI #RiskManagement #MachineLearning #Compliance #DataEngineering
