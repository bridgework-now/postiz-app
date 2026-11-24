import {
  ThirdParty,
  ThirdPartyAbstract,
} from '@gitroom/nestjs-libraries/3rdparties/thirdparty.interface';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import { timer } from '@gitroom/helpers/utils/timer';

@ThirdParty({
  identifier: 'heygen',
  title: 'HeyGen',
  description: 'HeyGen is a platform for creating AI-generated avatars videos.',
  position: 'media',
  fields: [],
})
export class HeygenProvider extends ThirdPartyAbstract<{
  voice: string;
  avatar: string;
  aspect_ratio: string;
  captions: string;
}> {
  // @ts-ignore
  constructor(private _openaiService: OpenaiService) {
    super();
  }

  async checkConnection(
    apiKey: string
  ): Promise<false | { name: string; username: string; id: string }> {
    const list = await fetch('https://api.heygen.com/v3/users/me', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
      },
    });

    if (!list.ok) {
      return false;
    }

    const { data } = await list.json();

    return {
      name: data.first_name + ' ' + data.last_name,
      username: data.username,
      id: data.username,
    };
  }

  async generateVoice(apiKey: string, data: { text: string }) {
    return {
      voice: await this._openaiService.generateVoiceFromText(data.text),
    };
  }

  private async listPages(
    apiKey: string,
    path: string,
    maximum = Infinity
  ) {
    const url = new URL(path, 'https://api.heygen.com');
    url.searchParams.set('limit', String(Math.min(50, maximum)));
    const items = [];
    const tokens = new Set<string>();
    while (true) {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-api-key': apiKey,
        },
      });
      if (!response.ok) {
        throw new Error('HeyGen listing failed');
      }
      const page = await response.json();
      items.push(...page.data);
      if (items.length >= maximum || !page.has_more) {
        return items.slice(0, maximum);
      }
      if (!page.next_token || tokens.has(page.next_token)) {
        throw new Error('Invalid HeyGen pagination cursor');
      }
      tokens.add(page.next_token);
      url.searchParams.set('token', page.next_token);
    }
  }

  async voices(apiKey: string) {
    const privateVoices = await this.listPages(
      apiKey,
      '/v3/models/audio/voices?type=private',
      20
    );
    if (privateVoices.length >= 20) {
      return privateVoices;
    }
    const publicVoices = await this.listPages(
      apiKey,
      '/v3/models/audio/voices?type=public',
      20 - privateVoices.length
    );
    return [...privateVoices, ...publicVoices];
  }

  async avatars(apiKey: string) {
    const avatarGroups = await this.listPages(
      apiKey,
      '/v3/avatars?ownership=private'
    );
    const loadedAvatars = [];
    for (const avatar of avatarGroups) {
      const looks = await this.listPages(
        apiKey,
        `/v3/avatars/looks?ownership=private&group_id=${encodeURIComponent(avatar.id)}`
      );
      loadedAvatars.push(
        ...looks.map((look) =>
          look.avatar_type === 'photo_avatar'
            ? {
                ...look,
                image_url: look.preview_image_url,
              }
            : {
                ...look,
                id: undefined,
                avatar_id: look.id,
                avatar_name: look.name,
              }
        )
      );
    }

    return loadedAvatars;
  }

  async sendData(
    apiKey: string,
    data: {
      voice: string;
      avatar: string;
      aspect_ratio: string;
      captions: string;
      selectedVoice: string;
      type: 'talking_photo' | 'avatar';
    }
  ): Promise<string> {
    const {
      data: { video_id },
    } = await (
      await fetch(`https://api.heygen.com/v3/videos`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'avatar',
          avatar_id: data.avatar,
          script: data.voice,
          voice_id: data.selectedVoice,
          voice_settings: {
            engine_settings: {
              engine_type: 'heygen_voice',
              model: 'heygen-voice-1',
            },
          },
          engine: { type: 'avatar_iii' },
          resolution: '720p',
          aspect_ratio: data.aspect_ratio === 'story' ? '9:16' : '16:9',
          ...(data.captions === 'yes'
            ? { caption: { file_format: 'srt', style: 'default' } }
            : {}),
        }),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
      })
    ).json();

    let attempts = 0;
    const maxAttempts = 180; // ~9 minutes at 3s interval
    while (true) {
      if (attempts++ >= maxAttempts) {
        throw new Error('Video generation timed out');
      }

      const {
        data: { status, video_url, captioned_video_url },
      } = await (
        await fetch(
          `https://api.heygen.com/v3/videos/${encodeURIComponent(video_id)}`,
          {
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'x-api-key': apiKey,
            },
          }
        )
      ).json();

      if (status === 'completed') {
        return data.captions === 'yes'
          ? captioned_video_url || video_url
          : video_url;
      } else if (status === 'failed') {
        throw new Error('Video generation failed');
      }

      await timer(3000);
    }
  }
}
