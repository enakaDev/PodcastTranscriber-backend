import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { zValidator } from '@hono/zod-validator'
import { number, z } from 'zod'
import { XMLParser } from 'fast-xml-parser'
import  {  createClient  }  from  "@deepgram/sdk" ; 

type Bindings = {
    DEEPGRAM_API_KEY: string,
    DEEPL_API_KEY: string,
    RSS_LINKS: {
        name: string,
        url: string
    }[],
    DB: D1Database;
    TRANSCRIPTION_BUCKET: R2Bucket;
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors()) // CORS有効化

const channelSchema = z.object({
    channel: z.object({
        id: z.number().int(),
        rss_url: z.string().url(),
        title: z.string()
    })
})

const episodeSchema = z.object({
	episode: z.object({
        audioUrl: z.string().url(),
        title: z.string(),
        description: z.string().optional(),
    }),
    channel: z.object({
        id: z.number().int(),
        rss_url: z.string().url(),
        title: z.string()
    })
})


export async function fetchAndParseRSS(url: string) {
    // 1. fetchでRSSフィードを取得
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Failed to fetch RSS feed: ${response.status}`)
    }

    const xmlText = await response.text()

    // 2. fast-xml-parser でパース
    const parser = new XMLParser({
        ignoreAttributes: false
    })
    const parsed = parser.parse(xmlText)

    // 3. RSSフィードの中身にアクセスできる
    return parsed
}
app.post('/episodes', zValidator('json', channelSchema), async (c) => {
    const { channel } = await c.req.json();
    const rssUrl = channel.rss_url;

    try {
        const feed = await fetchAndParseRSS(rssUrl);
        if (!feed.rss.channel.item || feed.rss.channel.item.length === 0) {
            return c.json({ error: "No items found in RSS feed" }, 400);
        }

        const items: any[] = feed.rss.channel.item

        return c.json({ 
        episodes: items.map(item => {
            return {
            title: item.title,
            audioUrl: item.enclosure["@_url"],
            description: item.description
            }
        })
    })
    } catch (error: any) {
        console.error("Error during transcription:", error);
        return c.json({ error: "Transcription failed", details: error.stack }, 500);
    }
});

interface TranslateResponse {
    translations: {
        detected_source_language: string;
        text: string;
    }[];
}

app.post('/transcribe', zValidator('json', episodeSchema), async (c) => {
    const { episode, channel } = await c.req.json();
    const audioUrl = episode.audioUrl;
    const episodeTitle = episode.title;
    const channelTitle = channel.title;

    try {
        // Deepgram API へリクエスト
        const deepgramClient = createClient (c.env.DEEPGRAM_API_KEY);
        const {result, error} = await deepgramClient.listen.prerecorded.transcribeUrl(
        {
            url: audioUrl,
        },
        {
            model: "nova",
            paragraphs: true,
            diarize: true
        }
        );
        if (error) {
            return c.json({ error: "Deepgram API error", details: error }, 500);
        }

        const data = await result.results.channels[0].alternatives[0].transcript
        const segments = await result.results.channels[0].alternatives[0].paragraphs?.paragraphs.flatMap(p => p.sentences)

        await c.env.TRANSCRIPTION_BUCKET.put(
            // ファイル名としてチャンネル名とエピソード名を渡したい
            `transcriptions/${channelTitle}_${episodeTitle}.txt`,
            new TextEncoder().encode(data),
            {
                httpMetadata: {
                    contentType: 'text/plain',
                }
            }
        );

        // const res = await fetch(`https://api-free.deepl.com/v2/translate`, {
        //     method: 'POST',
        //     headers: {
        //         'Content-Type': 'application/json',
        //         Authorization: `DeepL-Auth-Key ${c.env.DEEPL_API_KEY}`,
        //     },
        //     body: JSON.stringify({
        //         text: [data],
        //         source_lang: 'EN', // 翻訳元の言語コード
        //         target_lang: 'JA', // 翻訳先の言語コード
        //     }),
        // });
        // const translatedResponse: TranslateResponse = await res.json(); 

        return c.json({ 
            transcription: {
                original: data,
                segments : segments,
                //translation: translatedResponse.translations[0].text
                translation: data // 一旦翻訳は無し
            }
        })
    } catch (error: any) {
        console.error("Error during transcription:", error);
        return c.json({ error: "Transcription failed", details: error.stack }, 500);
    }
});

app.get('/channel-list', async (c) => {
    const result = await c.env.DB.prepare('SELECT * FROM podcasts ORDER BY id DESC').all();
    if (!result.results || result.results.length === 0)
        return c.json({})
    try {
        const channelList = result.results.map((row) => ({
            id: row.id,
            rss_url: row.rss_url,
            title: row.title,
        }));
        //const rssList = c.env.RSS_LINKS ?? [];
        return c.json({ channelList });
    } catch (error: any) {
        console.error("Error fetching RSS list:", error);
        return c.json({ error: "Failed to fetch RSS list", details: error.stack }, 500);
    }
});

// URL バリデーション用
const newRssSchema = z.object({
	newRssUrl: z.string().url(),
})
app.post('/channel-register', async (c) => {
    const body = await c.req.json()

    const parsed = newRssSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'Invalid request body' }, 400)
    }
    
    const rss_url = parsed.data.newRssUrl

    try {
        const feed = await fetchAndParseRSS(rss_url);
        if (!feed.rss.channel.item || feed.rss.channel.item.length === 0) {
            return c.json({ error: "No items found in RSS feed" }, 400);
        }

        const title = feed.rss.channel.title;

        await c.env.DB.prepare(
            `INSERT INTO podcasts (rss_url, title) VALUES (?, ?)`
        ).bind(rss_url, title).run()
    
        return c.json({ message: 'Podcast registered' }, 201)
    } catch (error: any) {
        console.error("Error during podcast registration:", error);
        return c.json({ error: "Registration failed", details: error.stack }, 500);
    }
})

// URL バリデーション用
app.post('/channel-delete', async (c) => {
    const { delRssId } = await c.req.json();

    try {
        await c.env.DB.prepare(
            `DELETE FROM podcasts WHERE id = ${delRssId}`
        ).run()
    
        return c.json({ message: 'Podcast deleted' }, 201)
    } catch (error: any) {
        console.error("Error during podcast registration:", error);
        return c.json({ error: "Delete failed", details: error.stack }, 500);
    }
})

export default app
