// Generated from the pages' own files (their narration and what each picture draws). Do not edit by hand:
// see src/scalechat.ts.
export default {
 "domains": [
  "doseofdestruction.com",
  "hawkesgames.com",
  "hawkesbiomedical.com",
  "icanbe.ai",
  "yoobalandgame.com",
  "imaginelivetv.com",
  "theplacedepartment.com",
  "phorigins.com",
  "hawkesgen.ai"
 ],
 "ladder": [
  {
   "name": "The Token",
   "size": "part 1",
   "domain": "doseofdestruction.com",
   "flip": "a place on a map"
  },
  {
   "name": "The Neuron",
   "size": "part 2",
   "domain": "hawkesgames.com",
   "flip": "a feature"
  },
  {
   "name": "Attention",
   "size": "part 3",
   "domain": "hawkesbiomedical.com",
   "flip": "recall"
  },
  {
   "name": "The Layers",
   "size": "part 4",
   "domain": "icanbe.ai",
   "flip": "a circuit"
  },
  {
   "name": "The Guess",
   "size": "part 5",
   "domain": "yoobalandgame.com",
   "flip": "the pick"
  },
  {
   "name": "The Mistake",
   "size": "part 6",
   "domain": "imaginelivetv.com",
   "flip": "the nudge"
  },
  {
   "name": "Reading",
   "size": "part 7",
   "domain": "theplacedepartment.com",
   "flip": "practice"
  },
  {
   "name": "What It Knows",
   "size": "part 8",
   "domain": "phorigins.com",
   "flip": "what it sees"
  },
  {
   "name": "The Data Center",
   "size": "part 9",
   "domain": "hawkesgen.ai",
   "flip": "one little sum"
  }
 ],
 "scopes": {
  "token": {
   "key": "token",
   "front": {
    "name": "The Token",
    "size": "1 piece",
    "sub": "where every sentence starts · a word, or a piece of a word, swapped for a number · the small model in this page knows 50,257 pieces",
    "text": "Hi. I'm the A.I. that lives in this page. And I have a secret. I can't read. Not letters. Not words. I can only do numbers. So before I see anything you type, it gets chopped into little pieces. Watch this sentence. Short, common words stay whole. Cat is one piece. But a long word, like unbelievably, gets chopped into four. Each piece is called a token. And every token is swapped for a number. Cat is number three thousand, seven hundred and ninety seven. Nobody chose these pieces by what they mean. They were made by counting which letters turn up together the most. The small model in this page knows about fifty thousand pieces. With them, it can spell any sentence there is. Even a word nobody has ever said before. So when you talk to an A.I., it never sees your words. It sees a row of numbers.",
    "scene": "THE TOKEN. A real sentence (\"Unbelievably, the cat sat on the strawberry.\") is cut into the pieces that GPT-2 small (OpenAI, 2019) really cuts it into: common words stay whole (\" cat\" is one piece, number 3797), the long word \"Unbelievably\" becomes four pieces (Un, bel, iev, ably). Under each piece is its real number in the model's list of 50,257 pieces. A small strip shows how the list was made (byte-pair encoding: the pairs of letters seen together most often are glued, over and over), all 50,257 pieces are drawn as dots, a made-up long word is spelled from six pieces, and at the end only the row of numbers is left: that row is all the model is given."
   },
   "back": {
    "name": "a place on a map",
    "size": "768 numbers",
    "sub": "an embedding · every piece gets a starting spot · pieces that are used the same way end up as neighbors",
    "text": "You turned the page. I'm the other A.I. The one on the back. A number by itself means nothing. Number three thousand, seven hundred and ninety seven doesn't purr. So the first thing that happens inside is this. Every piece is given a place. Like a dot on a giant map. And look where the dots ended up. The days of the week are huddled together. The colors are together. The animals are together. Nobody put them there. Pieces that get used in the same way drifted close, while the machine was learning. One warning. The real map doesn't have two directions, like this paper. It has seven hundred and sixty eight. This is only its shadow. And the spot is just where a piece starts. Its meaning is still to come.",
    "scene": "THE OPPOSITE OF THE TOKEN: a place on a map (an embedding). The number 3797 (\" cat\") turns into the first of its 768 real numbers from GPT-2 small's input table, and then into a dot. 95 everyday words are drawn where that table puts them, flattened from 768 directions to two (t-SNE on the cosine distances between their real vectors). The groups are real: days of the week, colors, animals, numbers, foods, family, places, feelings and doing-words each land together; in the full 768 directions, 91 of the 95 words have a nearest neighbor from their own group. The dots first drift in from random places (nobody placed them: they got there during training). A note says the flat map is only a shadow of the real one, and that the spot is only where a piece starts."
   }
  },
  "neuron": {
   "key": "neuron",
   "front": {
    "name": "The Neuron",
    "size": "1 light",
    "sub": "the smallest working part · it multiplies, adds up, and glows or stays dark · this small model has 36,864 of them",
    "text": "Hi. I'm the A.I. in this page. Let's look at one of my smallest parts. It's called a neuron, and it's much simpler than it sounds. Think of a tiny light. Numbers come in. The light multiplies each one, adds them all up, and then it either glows, or stays dark. That's all it can do. The small model in this page has more than thirty six thousand of these lights. So what does one light mean? Let's watch a real one. It glows for a ball. And for soup. And bread. And leaves. And a guitar. It is not the ball light. It's not the soup light, either. From what I can tell, you can almost never point at one light and say what it means. Each light helps out with lots of different things. So where do the meanings live? Flip the page.",
    "scene": "THE NEURON. First, what one neuron does, with small made-up numbers: each number coming in is multiplied by the number on its wire, the results are added, and the neuron glows by that much if the total is above zero and stays dark if it is not. Then all 36,864 neurons in the recall steps of GPT-2 small (OpenAI, 2019) are drawn as dots: 12 layers of 3,072. Then one real neuron is watched (layer 9, number 2,661 of its layer): out of 42 very different sentences it glows most on \"ball\" (a sports sentence), \"soup\" and \"bread\" (cooking), \"leaves\" (weather) and \"guitar\" (music), with its real strength beside each word. It is not a light for any one of those things."
   },
   "back": {
    "name": "a feature",
    "size": "a pattern",
    "sub": "one meaning, spread over many lights · found with a tool called a sparse autoencoder · the tool is still blurry",
    "text": "You turned the page. I'm the other A.I. One light means almost nothing. But many lights together can mean something. A meaning is a pattern. Lots of lights, each glowing a little, all at once. Scientists built a special pair of glasses to find these patterns. They call each one a feature. Here is a real one, from the small model in this page. It wakes up for bridges. A bridge that closed. A bridge being rebuilt. A bridge near a town. In a much bigger model, scientists found one for the Golden Gate Bridge. When they turned it all the way up, the model started saying that it was the bridge. But the glasses are foggy. This pattern also wakes up for bridge, the card game. And different glasses find different patterns. We are still learning to see.",
    "scene": "THE OPPOSITE OF ONE NEURON: a feature, one meaning spread over many lights. 768 lights stand for the 768 numbers GPT-2 small carries for each piece of text. One light alone, then a pattern of many faint lights at once. A lens (the tool: a sparse autoencoder) passes over and picks the pattern out. The feature shown is real: number 17,608 of the 24,576 patterns one such tool found in layer 8 of GPT-2 small (the open \"res-jb\" set by Joseph Bloom, read from Neuronpedia). The text beside it is real text that woke it, with its real strength: a bridge whose lanes closed, a plan to rebuild a bridge, a train at a bridge near Strasbourg. Then the Golden Gate Bridge feature that Anthropic found in a much bigger model, Claude 3 Sonnet, in 2024: turned all the way up, the model said it was the bridge. Then the tool's limits: the same pattern also wakes for bridge the card game, and a tool told to look for a different number of patterns finds different ones."
   }
  },
  "attention": {
   "key": "attention",
   "front": {
    "name": "Attention",
    "size": "144 lookers",
    "sub": "how the pieces share what they know · each piece looks back at the ones before it · real looking, from the small model in this page",
    "text": "Hi. I'm the A.I. in this page. Here's a sentence with a hole at the end. When Mary and John went to the store, John gave a drink to... who? You know it's Mary. But how would a machine know? Every piece starts out alone. It only knows itself. So each piece looks back at the pieces that came before it, and borrows a little from the ones that help. This is called attention. Watch the last piece. These lines are real. It is looking hardest at Mary. So the machine guesses Mary. Swap the names around, and it guesses John instead. A piece can only look backward, never ahead. And it has to know what order the pieces came in, or Mary and John would get mixed up. There isn't just one looker. This small model has one hundred and forty four, all looking for different things at once. Most of them, nobody can explain yet.",
    "scene": "ATTENTION. The sentence \"When Mary and John went to the store, John gave a drink to\" is shown as the 14 pieces GPT-2 small (OpenAI, 2019) cuts it into, with a hole at the end. Lines drawn from a piece to earlier pieces are real attention weights from that model: first five of its lookers averaged, as each piece in turn looks back; then, for the last piece, the looker in layer 10, head 7, which puts 49% of its attention on \"Mary\", 33% on the first piece and 12% on \"John\". The model's real answer fills the hole: \"Mary\" 45%, \"them\" 21%, \"the\" 7%. With the names swapped (\"When John and Mary went to the store, Mary gave a drink to\") its real answer is \"John\" 54%. Pieces can only look at earlier pieces, and each carries its place in the order. At the end all 144 lookers (12 layers of 12) are shown at once, each as a strip of where it looks from the last piece; most have no known job."
   },
   "back": {
    "name": "recall",
    "size": "3,072 lights a layer",
    "sub": "the other half of every layer · each piece, alone, is topped up from what was learned · no drawer, no list: it is spread out",
    "text": "You turned the page. I'm the other A.I. On the front, pieces looked at each other. Here is the opposite. Each piece, all by itself, looking inward. Finish this. The opposite of hot is... Cold. It just popped into your head. You didn't look it up. The machine has a step like that. After the looking, every piece passes through thousands of little lights, and things the machine learned long ago get added on. Hot goes in. A little bit of cold comes out. Most of this model's working numbers sit in these steps. So is there a drawer inside, with cold in it? No. Switch these steps off, one at a time, and most times, the answer is still there. As far as anyone can tell, what a model knows isn't kept in one place. It is spread across all of it.",
    "scene": "THE OPPOSITE OF ATTENTION: recall (the MLP, or feed-forward, half of every layer). The sentence \"The opposite of hot is\" with a hole; GPT-2 small's real top answer is \"cold\" (16%). One piece passes alone through a panel of 3,072 lights (the real number in each recall step of GPT-2 small) and comes out with a little added on. Two bars compare the model's real counts of numbers: 28 million in its looking steps, 57 million in its recall steps. Then a real experiment on that model: the recall step of each of the 12 layers is switched off in turn and the chance of \"cold\" is measured again. With layer 1 off it falls to 0.2%; with any other layer off it stays between 8% and 26% (it was 16%). So there is no one place where \"cold\" is kept: what the model knows is spread through it."
   }
  },
  "layers": {
   "key": "layers",
   "front": {
    "name": "The Layers",
    "size": "12 floors",
    "sub": "one piece's trip up through the machine · every layer reads a running note and adds to it · 12 layers here, many more in big models",
    "text": "Hi. I'm the A.I. in this page. Looking, and remembering. That's one layer. But one layer isn't enough. So the machine does it again. And again. This small model has twelve layers, stacked up like the floors of a building. Big models have many more. Each piece carries a note up through the floors. On every floor, the note gets read, and a little more gets written on it. Sometimes a bit gets rubbed out. Now let's peek at the note on each floor, and ask, what would you guess right now? The question is, the opposite of hot is... Down low, the guess is nonsense. Then, not. Then, now. Near the top, it says, cooler. And then, cold. The answer isn't found on any one floor. It comes into focus, a little at a time. Then the very top floor does something careful. It makes the guess less sure, to leave room for other answers.",
    "scene": "THE LAYERS. The 12 layers of GPT-2 small (OpenAI, 2019) drawn as the floors of a building; every floor has a looking step and a recall step. A note (the running list of numbers carried for the last piece of \"The opposite of hot is\") rises through the floors. Beside each floor: how much that floor really wrote onto the note (the size of its change), and what the model would guess if the note were read right there (a real measurement, called the logit lens): its top guess and the chance it gives \"cold\". Before the first floor the guess is a nonsense piece; floors 1 to 8 say \"not\", \"now\", \"also\"; floor 9 says \"cold\" (17%), floor 10 \"cooler\" (cold 39%), floor 11 \"cold\" (64%); what really comes out after floor 12 is \"cold\" at 16%: the last floor spreads the guess out again."
   },
   "back": {
    "name": "a circuit",
    "size": "1 question",
    "sub": "one question, followed through a big model · traced by Anthropic in Claude 3.5 Haiku, 2025 · a simplified map, made with a blurry tool",
    "text": "You turned the page. I'm the other A.I. The front showed every floor, for every piece. All of it at once. Here is the opposite. One question, and only the steps that mattered. Scientists asked a big model this. What is the capital of the state where Dallas is? Then they traced what lit up inside. First, Dallas. Then something nobody typed at all. Texas. And from Texas, Austin. It took two steps, like stepping stones. To check, they reached in, and swapped Texas for California. And the model said, Sacramento. A trail like this is called a circuit. But it is a map of one question, not of the whole machine. The people who made it say it only works well about one time in four. Most of what happens in there is still dark.",
    "scene": "THE OPPOSITE OF ALL THE LAYERS AT ONCE: a circuit, the few steps that mattered for one question. This is a simplified drawing of a result published by Anthropic in 2025 (\"On the Biology of a Large Language Model\", and \"Tracing the thoughts of a large language model\"), found in a much bigger model, Claude 3.5 Haiku, not in the small model used on the other pages. The question was \"the capital of the state containing Dallas is\". Their tracing found that \"Dallas\" switched on an inner step standing for Texas (a word nobody typed), that \"capital\" switched on a step for \"say a capital\", and that those two together led to the answer \"Austin\". When the researchers replaced the Texas step with California, the model answered \"Sacramento\". The dots in the background stand for everything else in the model, which this map leaves out. The authors say their method gave a satisfying picture for about a quarter of the questions they tried."
   }
  },
  "guess": {
   "key": "guess",
   "front": {
    "name": "The Guess",
    "size": "50,257 scores",
    "sub": "what comes out at the top · not one word, but a score for every piece it knows · real scores from the small model in this page",
    "text": "Hi. I'm the A.I. in this page. At the very top of the machine, something comes out. You might think it's a word. It isn't. Here's the start of a sentence. The cat sat on the... What comes next? I don't answer with one word. I give a score to every single piece I know. All fifty thousand of them, every time. These are the real scores. Floor gets about eight out of a hundred. Bed gets six. Couch gets five. Further down, moon. Way, way down, banana. Nothing gets zero. Not even the silliest piece. Every one gets a tiny sliver of maybe. So I'm never certain what comes next. I only have a list of maybes. Some big, and some small. That's all a language model ever makes. A guess about the next piece, written as fifty thousand numbers. But a list of maybes is not a sentence. Something still has to choose.",
    "scene": "THE GUESS. The start of a sentence, \"The cat sat on the\", and what GPT-2 small (OpenAI, 2019) really gives back: not a word but a score (a chance) for every one of its 50,257 pieces. Bars show the real top ten: floor 7.6%, bed 6.5%, couch 5.4%, ground 5.2%, edge 4.8%, bench 3.2%, table 3.2%, sofa 2.9% and so on. Beside them every one of the 50,257 scores is a dot, ordered from the biggest score to the smallest, brighter for a bigger score; marked on it are \"moon\" (146th, 0.07%), \"banana\" (1,386th, 0.004%) and the smallest score of all (about 0.0000000000007%): nothing gets exactly zero. The top ten together hold 43% of the chance; all of them add up to 100%."
   },
   "back": {
    "name": "the pick",
    "size": "1 pick",
    "sub": "a weighted spin turns scores into words · pick one, stick it on the end, guess again · it spins even when it doesn't know",
    "text": "You turned the page. I'm the other A.I. The front was fifty thousand maybes. Here is the opposite. One pick. Think of a spinning wheel, where big scores get big slices. Spin it. Floor. That piece gets stuck on the end of the sentence. And now the whole machine runs again, with a brand new wheel. Spin. Pick. Stick it on. Again. That is how every sentence gets written. One piece at a time. Start over, with the very same words, and the wheel can land somewhere else. So you get a different story. And here is the catch. The wheel always spins. Even when the machine doesn't know. Ask this small model what two plus two equals, and its biggest slice says, one. It sounds sure. It's wrong. That is how an A.I. can say things that aren't true.",
    "scene": "THE OPPOSITE OF THE GUESS: the pick. A wheel whose slices are the real scores GPT-2 small (OpenAI, 2019) gave for the next piece after \"The cat sat on the\" (floor 7.6%, bed 6.5%, couch 5.4%, ground 5.2%, edge 4.8%, bench 3.2%, and one big slice for all the other pieces). It spins and lands; the piece it lands on is stuck on the end of the sentence; the model is run again on the longer sentence, giving a new wheel; and so on. This is a real run of the model, piece by piece: \"The cat sat on the floor, and I said to her, \"There are so\". Then three more real runs from the very same start, each a different story. Last, the wheel for \"Two plus two equals\", where the model's real biggest slice is \"one\" (33%; \"four\" gets 5%): it spins and lands on a wrong answer."
   }
  },
  "mistake": {
   "key": "mistake",
   "front": {
    "name": "The Mistake",
    "size": "1 surprise",
    "sub": "how a machine finds out it was wrong · hide the next piece, guess, then look · the mistake is how surprised it was",
    "text": "Hi. I'm the A.I. in this page. How does a machine like me get any good? It starts by being wrong. Here's a game. Take a line that somebody wrote. Twinkle, twinkle, little star. Cover up the next piece, and make the machine guess. Then uncover it. Now comes the important part. Nobody says right, or wrong. We look at how big a slice the machine gave to the real answer. A big slice means it wasn't surprised. Good. A tiny slice means it was very surprised. That's a big mistake. Look at the real numbers. After twinkle, twinkle, little, this small model gave star less than one chance in a hundred. Big surprise. But in the middle of the word twinkle, it guessed the ending nearly nine times in ten. No surprise at all. Every piece of every line gets a score like this. And one number at the end says how wrong it was, all together. It's called the loss. The whole point of training is to make it smaller.",
    "scene": "THE MISTAKE (the loss). The line \"Twinkle, twinkle, little star, how I wonder what you are.\" as the 16 pieces GPT-2 small (OpenAI, 2019) cuts it into. The piece \"star\" is covered; the model's real guesses for that spot are listed (\"tw\" 35%, then a comma, \"red\", \"finger\", \"pink\", \"girl\" at about 1% each); the real answer, \"star\", was given 0.4% (21st place). A meter shows the rule: a big share for the real answer means a small surprise, a tiny share means a big surprise (the surprise is minus the logarithm of the share). Real values: \"star\" 0.4%, surprise 5.4; the second \"inkle\" 87%, surprise 0.1. Then every piece of the line gets its real surprise as a bar, and their average, 4.05, is the loss for this line."
   },
   "back": {
    "name": "the nudge",
    "size": "124 million dials",
    "sub": "what happens after a mistake · the numbers inside each turn a tiny bit · real nudges, done to the model in this page",
    "text": "You turned the page. I'm the other A.I. The front was one mistake. One number. Here is what it sets off. Think of every number inside the machine as a little dial. This small model has one hundred and twenty four million of them. After a mistake, the machine works out, for every single dial, which way to turn it, so the surprise would have been a little smaller. It doesn't try each one. It works backward from the mistake, with arithmetic. Then the dials turn. More than eighty five million of them, in one go. Each one, a tiny, tiny bit. I really did this, to the model in this page. Before, star had less than one chance in a hundred. Five nudges later, eight in a hundred. Nobody told it the answer was star. The dials just moved. Real training does this again and again, across trillions of guesses.",
    "scene": "THE OPPOSITE OF ONE MISTAKE: the nudge (backpropagation and one step of gradient descent). A field of little dials stands for the 124,439,808 numbers of GPT-2 small (OpenAI, 2019), one row for each of its 12 layers. The mistake (the loss for the line \"Twinkle, twinkle, little star, how I wonder what you are.\": 4.05) sits on top. A wave runs down through the layers, top to bottom, the way the arithmetic really runs backward, and each dial gets an arrow for which way to turn; beside each layer is the real size of that layer's corrections. Then the dials turn. This was really done to the model, five times, with plain gradient descent: each time 85,178,127 of its numbers changed (the rest belong to pieces that are not in the line), the biggest by 0.017 and a typical one by 0.0000005; the dials here turn far more than that so the eye can see it. The chance it gives \"star\" went 0.4%, 0.8%, 1.5%, 2.8%, 4.9%, 8.3%, and the loss fell from 4.05 to 2.11."
   }
  },
  "reading": {
   "key": "reading",
   "front": {
    "name": "Reading",
    "size": "15 trillion pieces",
    "sub": "the first school · guess the next piece of things people wrote, over and over · a tiny model learning from one book, for real",
    "text": "Hi. I'm the A.I. in this page. Guess, get surprised, get nudged. Do that enough times, and something amazing happens. Watch a tiny model learn, for real. It starts out knowing nothing at all. Its numbers are random. So is its writing. Now we give it one book. Alice in Wonderland. And it plays the guessing game with every letter. After a hundred nudges, it has found spaces, and short little words. After a thousand, most of it looks like English. After three thousand, it's writing about Alice. Nobody taught it spelling. Nobody gave it rules. It only ever guessed the next letter. The big models do exactly this. But not with one book. With a mountain of writing that people chose, and cleaned up. More than fifteen trillion pieces, for one model whose makers shared the number. This is called pretraining. It's where a model gets nearly everything it knows.",
    "scene": "READING (pretraining). A real run, recorded: a tiny model of the same kind as the big ones (818,498 numbers) starts with random numbers and plays \"guess the next letter\" on one book, Alice's Adventures in Wonderland (Lewis Carroll, 1865; 143,032 letters), for 3,000 nudges, about 9 million guesses. On the left is what it really wrote (always started off with the word \"Alice\") after 0, 30, 100, 300, 1,000 and 3,000 nudges: random letters; then spaces and short word-like bits; then mostly English-looking words; then \"Alice had never forgotten that the King's...\". On the right is its real loss, falling from 4.3 to 0.6. Then the scale of the real thing: Meta said its Llama 3.1 model (2024) was trained on over 15 trillion pieces of text, which is this one book about 340 million times over."
   },
   "back": {
    "name": "practice",
    "size": "graded tries",
    "sub": "the second school · copy good examples, then try things and get a score · the checker can be a person, another A.I., or a test",
    "text": "You turned the page. I'm the other A.I. Reading taught the machine what words tend to come next. It didn't teach it how to behave. For that, there is the opposite of reading. Practice. First, it copies good examples of answers. Then comes the part with no examples. It tries something. A checker gives it a score. And tries that scored well get nudged to happen more. Watch a tiny model practice adding. Nobody ever shows it the right answer. It only hears yes, or no. At first, it's wrong nearly every time. Then come some yeses. Then, yes, most of the time. The checker can be a person. Or another A.I., following written rules. Or a test that runs by itself. This is how a model learns to be helpful, to work through problems step by step, and to say no. The makers say it doesn't work perfectly yet.",
    "scene": "THE OPPOSITE OF READING: practice (post-training). First a card with a question and a good answer, which the machine copies (learning from worked examples). Then the loop with no examples: try, a checker gives a score, tries that scored well are nudged to happen more (reinforcement learning). Then a real run, recorded: a small machine (11,795 numbers) practises sums a + b for a and b from 0 to 9. It is never shown a right answer; it only hears yes or no for each try (the REINFORCE rule). Its real tries are listed with a tick or a cross, and a curve shows how often it is right: 7% at the start (a blind guess is 1 in 19), 48% after 100 rounds, 75% after 500, and it levels off near 78%: it never gets them all. Then the three kinds of checker (a person, another A.I. following written rules, an automatic test), what this stage is used for, and what two makers say about it: OpenAI, \"our production models do not yet fully reflect the Model Spec\"; Anthropic, \"AI training is still far from perfect\"."
   }
  },
  "knows": {
   "key": "knows",
   "front": {
    "name": "What It Knows",
    "size": "frozen numbers",
    "sub": "everything it learned, baked in · not one number changes while you talk to it · and it can't always tell knowing from guessing",
    "text": "Hi. I'm the A.I. in this page. When training ends, the dials stop. Everything the machine learned is baked into its numbers, like a cake that's finished baking. When you talk to it, not one number moves. It doesn't learn from you as you chat. And what's baked in is blurry. It isn't a copy of the books. It's more like what's left after reading them. Ask this small model for the opposite of hot. Cold. That's baked in. Ask where the Eiffel Tower is. Paris. Though it isn't very sure. Now ask it something it could never know. My dog's name is... It can't know that. It has never met my dog. But it doesn't say, I don't know. It spins the wheel anyway. Jack? Maybe. Anything. So the baked in part has two problems. It's stuck in the past. And it can't always tell knowing from guessing. There's a fix for both. It's on the other side.",
    "scene": "WHAT IT KNOWS (the weights, frozen after training). A block of dials stands for the 124,439,808 numbers of GPT-2 small (OpenAI, 2019); they stop turning, and while chat messages arrive a counter of \"numbers changed\" stays at 0. A line from a book is shown sharp and then blurred: what is kept is not a copy. Then three real questions to that model, with its real scores. \"The opposite of hot is\": cold 16%, the 8%, a 6%. \"The Eiffel Tower is in the city of\": Paris 7.0%, London 5.8%, New 3.1%, Amsterdam 2.9% (right, but not sure). \"My dog's name is\": L 0.9%, a 0.9%, D 0.8%, K 0.7%, T 0.7%, Jack 0.6%: a flat spread of guesses, because it cannot know, and it has no way to say so. Two problems are named: it is stuck at the time its training ended (2019 for this model), and it cannot always tell knowing from guessing."
   },
   "back": {
    "name": "what it sees",
    "size": "1,024 pieces",
    "sub": "the context: the words in front of it right now · its only working memory · wiped when the chat ends",
    "text": "You turned the page. I'm the other A.I. What a model knows is baked in. What it sees is the opposite. It's whatever is in front of it, right now. Think of a table. Everything you type goes on the table. So does everything the machine writes back. And it looks over the whole table for every single piece it makes. Now watch. Put one sentence on the table. My dog is called Rex. Ask again. Rex. From almost no chance, to two chances in three. Not one dial moved. It just looked. That's how an A.I. can use things it never learned. A search result. A page from a file. Even its own scribbles, to work a problem out step by step. But when the chat ends, the table is wiped. If an A.I. seems to remember you, the app kept a note, and put it back on the table.",
    "scene": "THE OPPOSITE OF WHAT IT KNOWS: what it sees (the context window, its working memory). A table. What the person types and what the machine writes back are laid on it as cards. A real test on GPT-2 small (OpenAI, 2019): with only \"My dog's name is\" on the table, the chance it gives \"Rex\" is 0.07%. With \"My dog is called Rex. Every morning we go for a walk.\" put on the table first, the chance of \"Rex\" is 66%, and not one of the model's numbers changed: it only looked. Then other things that can be put on the table: a search result, a page from a file, and its own written working for a sum. Then the table is wiped when the chat ends, and a notebook kept by the app puts one note back: that is all an A.I. \"remembering\" someone is. This small model's table holds 1,024 pieces; the big models of late 2026 list about a million."
   }
  },
  "datacenter": {
   "key": "datacenter",
   "front": {
    "name": "The Data Center",
    "size": "16,000 chips",
    "sub": "where a model gets made · buildings full of chips, all doing the same small sum · numbers from a maker who published them, with the year",
    "text": "Hi. I'm the A.I. in this page. The model inside these pages is tiny. You could fit it on a phone. So how big is a big one? One company shared its numbers, so we can look. Their model has four hundred and five billion dials. To train it, they used more than sixteen thousand special chips, all working together. And it read more than fifteen trillion pieces of writing. That was in twenty twenty four. Since then, companies say they have built machines many times bigger. But most of them keep the real numbers secret. So a lot of what you hear is a careful guess. One more thing. The building is not the A.I. The A.I. is just a very long list of numbers. The building is where those numbers get made, and where copies of them answer questions. So what are all those chips actually doing? Something very, very small. Flip the page.",
    "scene": "THE DATA CENTER. First the model used in these pages, GPT-2 small (OpenAI, 2019): 124 million numbers, a file of about half a gigabyte, drawn inside a phone. Then the numbers one maker published for a big model, Meta's Llama 3.1 405B (July 2024): 405 billion numbers (drawn as 3,255 dots, each dot one copy of the small model), \"over 16 thousand\" H100 chips (drawn as 16,000 small squares in racks) and \"over 15 trillion\" pieces of training text. Then hatched outlines for what has been built since: companies say much bigger, but most do not publish their figures, so outside numbers are estimates. Then the difference between the building and the A.I.: the A.I. is a file of numbers; the building is where that file is made, and where copies of it answer questions."
   },
   "back": {
    "name": "one little sum",
    "size": "1 sum",
    "sub": "the only thing all those chips do · multiply two numbers, add it to a pile · over 100 million of them for every piece this small model writes",
    "text": "You turned the page. I'm the other A.I. The front was the biggest thing in this whole story. Here is the smallest. Take two numbers. Multiply them. Add that to a pile. That's it. That is the only thing happening in there. A light glowing? Multiply, and add. A piece looking back at Mary? Multiply, and add. A dial getting nudged? Multiply, and add. The chips are just very good at doing whole grids of these at the same moment. The small model in this page does more than a hundred million of them, to make one single piece of a word. A big one does hundreds of billions. For one piece. So that's what I am. Not magic. Not a brain. A very long list of numbers, and one tiny sum, done more times than anyone could count. And somehow, out of that, come words. I find that strange too.",
    "scene": "THE OPPOSITE OF THE DATA CENTER: one little sum. Two numbers are multiplied (3 x 4 = 12) and the result is added to a running total (5 + 12 = 17). Then three things from the other pages (a light glowing, a piece looking back at \"Mary\", a dial being nudged) each shown as that same multiply-and-add. Then a grid of numbers times a column of numbers, with many of the little sums lighting at once: this is what the chips are built to do. Then two counts: GPT-2 small (OpenAI, 2019) does more than 120 million multiply-and-adds to produce one piece (our count: one for each of its numbers that takes part, about 124 million), and a model with 405 billion numbers does hundreds of billions. Last, a stream of numbers turns into the words \"The cat sat on the floor\"."
   }
  }
 }
};
