import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import NumberInput from '../components/NumberInput';
import DurationInput from '../components/DurationInput';
import Button from '../components/Button';
import Banner from '../components/Banner';
import { Input, Select } from '../components/FormControls';

export default function DestinationPanel({
  settings,
  setSettings,
  user,
  ingestChoice,
  setIngestChoice,
  customServer,
  setCustomServer,
  showKey,
  setShowKey,
  savingSettings,
  onSave,
}) {
  return (
    <CollapsiblePanel storageKey="destination" title="Sendeziel">
      <Hint style={{ color: 'var(--color-success, #4caf50)' }}>
        Stream-Key wurde nach dem Login automatisch geladen.
      </Hint>
      <Form onSubmit={onSave}>
        {Number(settings.videoBitrateKbps) > 6000 &&
          !['affiliate', 'partner'].includes(
            String(user.broadcasterType || '').toLowerCase(),
          ) && (
            <Banner type="error" role="alert">
              Achtung, Twitch erlaubt für nicht Affiliate oder Partner Streamer
              nicht mehr als 6000kbps
            </Banner>
          )}
        <Field>
          <span>Ingest-Server</span>
          <Select
            value={ingestChoice}
            onChange={(event) => setIngestChoice(event.target.value)}
          >
            <option value="rtmp://live.twitch.tv/app">
              Automatisch (live.twitch.tv)
            </option>
            <option value="rtmp://fra02.contribute.live-video.net/app">
              Frankfurt
            </option>
            <option value="rtmp://prg02.contribute.live-video.net/app">
              Prag
            </option>
            <option value="rtmp://vie02.contribute.live-video.net/app">
              Wien
            </option>
            <option value="rtmp://ams03.contribute.live-video.net/app">
              Amsterdam
            </option>
            <option value="custom">Benutzerdefiniert</option>
          </Select>
        </Field>
        {ingestChoice === 'custom' && (
          <Field>
            <span>Server-URL</span>
            <Input
              type="text"
              value={customServer}
              onChange={(event) => setCustomServer(event.target.value)}
              placeholder="rtmp://…"
            />
          </Field>
        )}
        {user.role === 'broadcaster' && (
          <Field>
            <span>Stream-Key</span>
            <KeyInput>
              <Input
                type={showKey ? 'text' : 'password'}
                value={settings.streamKey}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    streamKey: event.target.value,
                  }))
                }
                placeholder="live_xxxxxxxxxxxxxxxxxxxx"
                autoComplete="off"
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? 'Verbergen' : 'Anzeigen'}
              </Button>
            </KeyInput>
          </Field>
        )}
        <BitrateRow>
          <Field>
            <span>Video-Bitrate (kbps)</span>
            <NumberInput
              value={settings.videoBitrateKbps}
              min={500}
              max={10000}
              step={100}
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  videoBitrateKbps: value,
                }))
              }
            />
          </Field>
          <Field>
            <span>Audio-Bitrate (kbps)</span>
            <NumberInput
              value={settings.audioBitrateKbps}
              min={32}
              max={320}
              step={8}
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  audioBitrateKbps: value,
                }))
              }
            />
          </Field>
          <Field>
            <span>Framerate (FPS)</span>
            <NumberInput
              value={settings.streamFps}
              min={1}
              max={120}
              step={1}
              onChange={(value) =>
                setSettings((current) => ({ ...current, streamFps: value }))
              }
            />
          </Field>
        </BitrateRow>
        <RestartRow>
          <Field>
            <span>Automatischer Neustart nach (HH:MM:SS)</span>
            <DurationInput
              value={settings.restartIntervalSeconds}
              maxSeconds={604800}
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  restartIntervalSeconds: value,
                }))
              }
            />
          </Field>
          <Field>
            <span>Pause vor Neustart (HH:MM:SS)</span>
            <DurationInput
              value={settings.restartDelaySeconds}
              maxSeconds={3600}
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  restartDelaySeconds: value,
                }))
              }
            />
          </Field>
        </RestartRow>
        <Button variant="primary" type="submit" disabled={savingSettings}>
          {savingSettings ? 'Speichert…' : 'Speichern'}
        </Button>
      </Form>
    </CollapsiblePanel>
  );
}

const Hint = styled.p`
  margin: 0 0 16px;
  color: var(--text-dim);
  font-size: 0.85rem;
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 14px;
`;

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.85rem;
  color: var(--text-dim);
`;

const KeyInput = styled.div`
  display: flex;
  gap: 8px;
  input {
    flex: 1;
  }
`;

const BitrateRow = styled.div`
  display: flex;
  gap: 1rem;
  width: 100%;
  align-items: center;
  justify-content: center;
`;

const RestartRow = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;

  @media (max-width: 640px) {
    grid-template-columns: 1fr;
  }
`;

