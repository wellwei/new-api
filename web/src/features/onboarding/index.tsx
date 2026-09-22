/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  BookOpen,
  Check,
  Circle,
  KeyRound,
  Loader2,
  Send,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { SectionPageLayout } from '@/components/layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DASHBOARD_DEFAULT_SECTION } from '@/features/dashboard/section-registry'
import { createApiKey, fetchTokenKey, getApiKeys } from '@/features/keys/api'
import {
  getApiKeyFormDefaultValues,
  transformFormDataToPayload,
} from '@/features/keys/lib'
import type { ApiKey } from '@/features/keys/types'
import { useStatus } from '@/hooks/use-status'
import { getUserModels } from '@/lib/api'
import { markOnboardingDone } from '@/lib/onboarding'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

const STEP_IDS = ['create', 'connect', 'verify'] as const
type StepId = (typeof STEP_IDS)[number]

const STEP_TITLE_KEYS: Record<StepId, string> = {
  create: 'Create an API key',
  connect: 'Copy it into your client',
  verify: 'Send one test request',
}

interface CreatedKey {
  id: number
  name: string
  secret: string
}

interface VerifyResult {
  ok: boolean
  /** Assistant reply on success, or the gateway's own message on failure. */
  detail: string
}

/** The gateway's own address: an admin-set canonical one when present. */
function resolveBaseUrl(serverAddress: unknown): string {
  const configured =
    typeof serverAddress === 'string' ? serverAddress.trim() : ''
  return (configured || window.location.origin).replace(/\/+$/, '')
}

function buildCurlCommand(args: {
  baseUrl: string
  apiKey: string
  model: string
}): string {
  return [
    `curl ${args.baseUrl}/v1/chat/completions \\`,
    '  -H "Content-Type: application/json" \\',
    `  -H "Authorization: Bearer ${args.apiKey}" \\`,
    `  -d '{"model":"${args.model}","messages":[{"role":"user","content":"Hello"}]}'`,
  ].join('\n')
}

function StepMarker(props: { done: boolean; active: boolean }) {
  const Icon = props.done ? Check : Circle
  return (
    <span
      className={cn(
        'bg-background relative z-10 flex size-8 shrink-0 items-center justify-center rounded-lg border shadow-xs',
        props.done && 'border-success/30 bg-success/10',
        props.active && !props.done && 'border-primary/40 bg-primary/5'
      )}
      aria-hidden='true'
    >
      <Icon
        className={cn(
          'size-4',
          props.done ? 'text-success' : 'text-muted-foreground'
        )}
      />
    </span>
  )
}

/**
 * First-run guide for a brand-new account.
 *
 * Registration ends with an empty console: no key, no idea which address to
 * point a client at. The wizard closes that gap in the order the reader needs
 * it — create the key, copy it together with the gateway address, then send one
 * real request so success is proven rather than described. Every step is
 * optional (the reader can skip at any point) and the whole thing is
 * re-enterable from the API keys page.
 */
export function Onboarding() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.auth.user)
  const { status } = useStatus()

  const [step, setStep] = useState<StepId>('create')
  const [keyName, setKeyName] = useState(() => t('My key'))
  const [created, setCreated] = useState<CreatedKey | null>(null)
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)

  const keysQuery = useQuery({
    queryKey: ['onboarding', 'api-keys'],
    queryFn: async () => {
      const result = requireServerSuccess(await getApiKeys({ p: 1, size: 10 }))
      return result.data?.items ?? []
    },
    staleTime: 30 * 1000,
  })

  const modelsQuery = useQuery({
    queryKey: ['onboarding', 'user-models'],
    queryFn: async () => {
      const result = requireServerSuccess(await getUserModels())
      return result.data ?? []
    },
    staleTime: 5 * 60 * 1000,
  })

  const defaultUseAutoGroup = status?.default_use_auto_group === true
  const baseUrl = resolveBaseUrl(status?.server_address)
  const existingKeys: ApiKey[] = keysQuery.data ?? []
  const testModel = modelsQuery.data?.[0] ?? ''
  const secret = created?.secret ?? ''
  const displayKey = created
    ? `sk-${created.secret}`
    : t('Your key will appear here')

  const createKey = useMutation({
    mutationFn: async (name: string) => {
      const payload = transformFormDataToPayload({
        ...getApiKeyFormDefaultValues(defaultUseAutoGroup),
        name,
      })
      requireServerSuccess(await createApiKey(payload))

      // `POST /api/token/` answers with `{success: true}` and no payload, so
      // the new key is identified from the list instead: it is the one with an
      // id the caller did not have before.
      const knownIds = new Set(existingKeys.map((key) => key.id))
      const result = requireServerSuccess(await getApiKeys({ p: 1, size: 20 }))
      const added = (result.data?.items ?? []).find(
        (key) => !knownIds.has(key.id)
      )
      if (!added) {
        throw new Error(t('The key was created but could not be read back.'))
      }

      // The list only carries a masked key; the plaintext is fetched once so
      // the reader can copy it without a second detour to the keys page.
      const keyResponse = await fetchTokenKey(added.id)
      const plaintext = keyResponse.success ? keyResponse.data?.key : ''
      if (!plaintext) {
        throw new Error(t('The key was created but could not be read back.'))
      }
      return {
        id: added.id,
        name: added.name,
        secret: plaintext,
      } satisfies CreatedKey
    },
    onSuccess: (createdKey) => {
      setCreated(createdKey)
      setVerifyResult(null)
      setStep('connect')
      void queryClient.invalidateQueries({
        queryKey: ['onboarding', 'api-keys'],
      })
    },
  })

  const verifyRequest = useMutation({
    mutationFn: async (): Promise<VerifyResult> => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [
            { role: 'user', content: t('Say hello in one short sentence.') },
          ],
          max_tokens: 64,
        }),
      })
      const body = (await response.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[]
        error?: { message?: string }
        message?: string
      } | null

      if (!response.ok) {
        return {
          ok: false,
          detail:
            body?.error?.message ||
            body?.message ||
            t('The gateway answered HTTP {{status}}.', {
              status: response.status,
            }),
        }
      }
      return {
        ok: true,
        detail: body?.choices?.[0]?.message?.content ?? '',
      }
    },
    onSuccess: (result) => {
      setVerifyResult(result)
    },
  })

  const finish = useCallback(() => {
    markOnboardingDone(user?.id)
    void navigate({
      to: '/dashboard/$section',
      params: { section: DASHBOARD_DEFAULT_SECTION },
    })
  }, [navigate, user?.id])

  const activeIndex = STEP_IDS.indexOf(step)
  // Steps one and two are done once a key exists; the third only once a real
  // request came back green.
  const completedCount = (created ? 2 : 0) + (verifyResult?.ok ? 1 : 0)

  const curlCommand = useMemo(
    () =>
      buildCurlCommand({
        baseUrl,
        apiKey: created ? displayKey : 'sk-...',
        model: testModel || 'gpt-4o-mini',
      }),
    [baseUrl, created, displayKey, testModel]
  )

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Get started')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button variant='ghost' size='sm' onClick={finish}>
          {t('Skip for now, take me to the console')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='mx-auto grid w-full max-w-5xl gap-4 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]'>
          <ol className='bg-card h-fit rounded-2xl border p-2 shadow-xs'>
            {STEP_IDS.map((id, index) => {
              const isActive = id === step
              const isDone = index < activeIndex
              return (
                <li
                  key={id}
                  className='relative flex gap-3 pb-3 last:pb-0'
                  aria-current={isActive ? 'step' : undefined}
                >
                  {index < STEP_IDS.length - 1 && (
                    <span
                      className='bg-border absolute top-9 bottom-1 left-4 w-px'
                      aria-hidden='true'
                    />
                  )}
                  <StepMarker done={isDone} active={isActive} />
                  <div className='flex min-w-0 flex-col gap-0.5 pt-1.5'>
                    <span className='text-muted-foreground font-mono text-xs tabular-nums'>
                      {index + 1}.
                    </span>
                    <span
                      className={cn(
                        'text-sm',
                        isActive ? 'font-medium' : 'text-muted-foreground'
                      )}
                    >
                      {t(STEP_TITLE_KEYS[id])}
                    </span>
                  </div>
                </li>
              )
            })}
            <li className='text-muted-foreground/70 mt-1 border-t px-2 pt-3 text-xs'>
              {t('Progress: {{done}}/{{total}}', {
                done: completedCount,
                total: STEP_IDS.length,
              })}
            </li>
          </ol>

          <section className='bg-card min-w-0 rounded-2xl border p-4 shadow-xs sm:p-6'>
            {step === 'create' && (
              <div className='flex flex-col gap-5'>
                <header className='flex flex-col gap-1.5'>
                  <h3 className='flex items-center gap-2 text-lg font-semibold'>
                    <Sparkles className='size-4' aria-hidden='true' />
                    {t('Create an API key')}
                  </h3>
                  <p className='text-muted-foreground text-sm leading-relaxed'>
                    {t(
                      'The key is your password for the API. Give it a name you will recognise later — one per device or app works well.'
                    )}
                  </p>
                </header>

                {existingKeys.length > 0 ? (
                  <div className='flex flex-col gap-3'>
                    <p className='text-sm'>
                      {t(
                        'You already have {{count}} key(s), so you can go straight on.',
                        {
                          count: existingKeys.length,
                        }
                      )}
                    </p>
                    <div className='flex flex-wrap items-center gap-2'>
                      <Button
                        size='sm'
                        onClick={async () => {
                          const first = existingKeys[0]
                          const response = await fetchTokenKey(first.id)
                          const plaintext = response.success
                            ? response.data?.key
                            : ''
                          if (plaintext) {
                            setCreated({
                              id: first.id,
                              name: first.name,
                              secret: plaintext,
                            })
                          }
                          setVerifyResult(null)
                          setStep('connect')
                        }}
                      >
                        {t('Continue with {{name}}', {
                          name: existingKeys[0].name,
                        })}
                        <ArrowRight data-icon='inline-end' />
                      </Button>
                      <Link
                        to='/keys'
                        className='text-muted-foreground hover:text-foreground text-xs underline underline-offset-4'
                      >
                        {t('Manage my keys')}
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div className='flex flex-col gap-3'>
                    <label
                      className='text-sm font-medium'
                      htmlFor='onboarding-key-name'
                    >
                      {t('Key name')}
                    </label>
                    <div className='flex flex-wrap gap-2'>
                      <Input
                        id='onboarding-key-name'
                        value={keyName}
                        onChange={(event) => setKeyName(event.target.value)}
                        placeholder={t('My key')}
                        className='min-w-0 flex-1 sm:max-w-xs'
                      />
                      <Button
                        onClick={() =>
                          createKey.mutate(keyName.trim() || t('My key'))
                        }
                        disabled={createKey.isPending || !keysQuery.isFetched}
                      >
                        {createKey.isPending ? (
                          <Loader2
                            className='animate-spin'
                            data-icon='inline-start'
                          />
                        ) : (
                          <KeyRound data-icon='inline-start' />
                        )}
                        {t('Create API Key')}
                      </Button>
                    </div>
                    {createKey.isError && (
                      <p className='text-destructive text-xs' role='alert'>
                        {createKey.error instanceof Error
                          ? createKey.error.message
                          : t('Failed to create the key')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {step === 'connect' && (
              <div className='flex flex-col gap-5'>
                <header className='flex flex-col gap-1.5'>
                  <h3 className='flex items-center gap-2 text-lg font-semibold'>
                    <KeyRound className='size-4' aria-hidden='true' />
                    {t('Copy it into your client')}
                  </h3>
                  <p className='text-muted-foreground text-sm leading-relaxed'>
                    {t(
                      'Two values are all any client needs: the address below and the key. You can look the key up again on the API keys page at any time.'
                    )}
                  </p>
                </header>

                {created && (
                  <dl className='flex flex-col gap-3'>
                    <div className='flex flex-col gap-1'>
                      <dt className='text-muted-foreground text-xs font-medium'>
                        {t('API address')}
                      </dt>
                      <dd className='bg-muted/40 flex items-center gap-2 rounded-lg border px-3 py-2'>
                        <code className='min-w-0 flex-1 truncate font-mono text-sm'>
                          {baseUrl}/v1
                        </code>
                        <CopyButton
                          value={`${baseUrl}/v1`}
                          aria-label={t('Copy API URL')}
                        />
                      </dd>
                    </div>
                    <div className='flex flex-col gap-1'>
                      <dt className='text-muted-foreground text-xs font-medium'>
                        {t('API key')}
                      </dt>
                      <dd className='bg-muted/40 flex items-center gap-2 rounded-lg border px-3 py-2'>
                        <code className='min-w-0 flex-1 truncate font-mono text-sm'>
                          {displayKey}
                        </code>
                        <CopyButton
                          value={displayKey}
                          aria-label={t('Copy API key')}
                        />
                      </dd>
                    </div>
                  </dl>
                )}

                <div className='flex flex-col gap-2'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='text-muted-foreground text-xs font-medium'>
                      {t('Try it from a terminal')}
                    </span>
                    <CopyButton
                      value={curlCommand}
                      variant='outline'
                      size='sm'
                      tooltip={t('Copy command')}
                      aria-label={t('Copy command')}
                    >
                      <span className='ms-1.5 text-xs'>{t('Copy')}</span>
                    </CopyButton>
                  </div>
                  <pre className='hover-scrollbar bg-muted/40 overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-relaxed'>
                    {curlCommand}
                  </pre>
                </div>

                <div className='flex flex-wrap items-center gap-2'>
                  <Button size='sm' onClick={() => setStep('verify')}>
                    {t('Next: send a test request')}
                    <ArrowRight data-icon='inline-end' />
                  </Button>
                  <Link
                    to='/docs/$pageId'
                    params={{ pageId: 'clients' }}
                    className='text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline underline-offset-4'
                  >
                    <BookOpen className='size-3.5' aria-hidden='true' />
                    {t('More client setups')}
                  </Link>
                </div>
              </div>
            )}

            {step === 'verify' && (
              <div className='flex flex-col gap-5'>
                <header className='flex flex-col gap-1.5'>
                  <h3 className='flex items-center gap-2 text-lg font-semibold'>
                    <Send className='size-4' aria-hidden='true' />
                    {t('Send one test request')}
                  </h3>
                  <p className='text-muted-foreground text-sm leading-relaxed'>
                    {t(
                      'This sends a real request through the gateway with the key you just made, so a green result means your setup genuinely works. It costs a fraction of a cent.'
                    )}
                  </p>
                </header>

                {testModel ? (
                  <p className='text-muted-foreground text-xs'>
                    {t('Test model: {{model}}', { model: testModel })}
                  </p>
                ) : (
                  <p className='text-muted-foreground text-xs'>
                    {t(
                      'No model is available for your account yet — pick one in the model square to see what is on offer.'
                    )}
                  </p>
                )}

                <div className='flex flex-wrap items-center gap-2'>
                  <Button
                    size='sm'
                    onClick={() => verifyRequest.mutate()}
                    disabled={verifyRequest.isPending || !created || !testModel}
                  >
                    {verifyRequest.isPending ? (
                      <Loader2
                        className='animate-spin'
                        data-icon='inline-start'
                      />
                    ) : (
                      <Send data-icon='inline-start' />
                    )}
                    {t('Send test request')}
                  </Button>
                  <Button variant='outline' size='sm' onClick={finish}>
                    {t('Finish and go to the console')}
                    <ArrowRight data-icon='inline-end' />
                  </Button>
                </div>

                {verifyResult && (
                  <div
                    className={cn(
                      'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
                      verifyResult.ok
                        ? 'border-success/30 bg-success/5'
                        : 'border-destructive/30 bg-destructive/5'
                    )}
                    role='status'
                  >
                    {verifyResult.ok ? (
                      <Check
                        className='text-success mt-0.5 size-4 shrink-0'
                        aria-hidden='true'
                      />
                    ) : (
                      <TriangleAlert
                        className='text-destructive mt-0.5 size-4 shrink-0'
                        aria-hidden='true'
                      />
                    )}
                    <div className='flex min-w-0 flex-col gap-1'>
                      <span className='font-medium'>
                        {verifyResult.ok
                          ? t('It works — the gateway answered')
                          : t('The request did not go through')}
                      </span>
                      {verifyResult.detail && (
                        <span className='text-muted-foreground break-words'>
                          {verifyResult.detail}
                        </span>
                      )}
                      {!verifyResult.ok && (
                        <Link
                          to='/docs/$pageId'
                          params={{ pageId: 'faq' }}
                          className='text-muted-foreground hover:text-foreground text-xs underline underline-offset-4'
                        >
                          {t('See the troubleshooting guide')}
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
