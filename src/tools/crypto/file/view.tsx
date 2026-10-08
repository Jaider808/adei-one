import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Check, Copy, Dice5, Eye, EyeOff, Lock, LockOpen } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ActionConfig, ToolViewProps } from '@/core/types'

type CryptoMode = 'encrypt' | 'decrypt' | 'loading'

const LOWER = 'abcdefghjkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ'
const DIGITS = '0123456789'
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?¿¡~/<>|'
const ALL = LOWER + UPPER + DIGITS + SYMBOLS
const PASS_LENGTH = 32

/** Índice seguro sin sesgo de módulo (muestreo por rechazo, como VERNAM). */
function rnd(max: number): number {
  const buf = new Uint32Array(1)
  const limit = Math.floor(0x100000000 / max) * max
  for (;;) {
    crypto.getRandomValues(buf)
    const v = buf[0] >>> 0
    if (v < limit) return v % max
  }
}

/** Genera una contraseña fuerte: mayúsculas, minúsculas, números y símbolos. */
function generatePassword(): string {
  const chars = Array.from({ length: PASS_LENGTH }, () => ALL[rnd(ALL.length)])
  // Garantiza al menos una de cada clase en posiciones fijas y baraja.
  chars[0] = UPPER[rnd(UPPER.length)]
  chars[1] = LOWER[rnd(LOWER.length)]
  chars[2] = DIGITS[rnd(DIGITS.length)]
  chars[3] = SYMBOLS[rnd(SYMBOLS.length)]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd(i + 1)
    const tmp = chars[i]
    chars[i] = chars[j]!
    chars[j] = tmp!
  }
  return chars.join('')
}

/**
 * Vista de "Encriptar archivo": detecta si el archivo es un contenedor `.adei`
 * → DESENCRIPTA (sin perfiles ni generador, botón "Desencriptar archivo"); si no,
 * ENCRIPTA (perfiles explicados + generador de contraseña fuerte). La contraseña
 * nunca sale del navegador.
 */
export function CryptoView({ artifact, onSubmit }: ToolViewProps) {
  const [mode, setMode] = useState<CryptoMode>('loading')
  const [passphrase, setPassphrase] = useState('')
  const [profile, setProfile] = useState<'standard' | 'high'>('standard')
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  // Auto-detección del contenedor .adei (igual que el engine).
  useEffect(() => {
    let active = true
    if (!artifact.file) {
      setMode('encrypt')
      return
    }
    artifact.file
      .slice(0, 4)
      .arrayBuffer()
      .then((buf) => {
        const b = new Uint8Array(buf)
        const isAdei =
          b.length >= 4 && b[0] === 0x41 && b[1] === 0x44 && b[2] === 0x45 && b[3] === 0x49
        if (active) setMode(isAdei ? 'decrypt' : 'encrypt')
      })
      .catch(() => {
        if (active) setMode('encrypt')
      })
    return () => {
      active = false
    }
  }, [artifact])

  async function copyPassphrase() {
    try {
      await navigator.clipboard.writeText(passphrase)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* portapapeles no disponible */
    }
  }

  const decrypting = mode === 'decrypt'
  const canSubmit = mode !== 'loading' && passphrase.trim().length > 0

  function handleSubmit() {
    if (!canSubmit) return
    onSubmit({
      passphrase: passphrase.trim(),
      ...(decrypting ? {} : { profile }),
    } as ActionConfig)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-4"
    >
      {mode === 'loading' ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : decrypting ? (
        <Alert>
          <AlertTitle className="flex items-center gap-2">
            <LockOpen className="size-4" aria-hidden="true" />
            Se desencriptará
          </AlertTitle>
          <AlertDescription>
            Este archivo está encriptado (.adei). Introduce la contraseña con la que se cifró
            para recuperar el archivo original. Sin la contraseña no hay forma de abrirlo.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle className="flex items-center gap-2">
            <Lock className="size-4" aria-hidden="true" />
            Se encriptará
          </AlertTitle>
          <AlertDescription>
            Tu archivo se cifrará con Argon2id + XChaCha20-Poly1305, 100% en tu navegador. Sin la
            contraseña, nadie podrá recuperarlo.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="crypto-passphrase">Contraseña</Label>
        <div className="flex gap-1.5">
          <Input
            id="crypto-passphrase"
            type={revealed ? 'text' : 'password'}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Introduce la contraseña"
            className="min-w-0 flex-1"
            autoComplete="off"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            title={revealed ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          >
            {revealed ? (
              <EyeOff className="size-4" aria-hidden="true" />
            ) : (
              <Eye className="size-4" aria-hidden="true" />
            )}
          </Button>
          {!decrypting && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setPassphrase(generatePassword())}
              aria-label="Generar contraseña segura"
              title="Generar contraseña segura (letras, números y símbolos)"
            >
              <Dice5 className="size-4" aria-hidden="true" />
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={copyPassphrase}
            disabled={!passphrase}
            aria-label="Copiar contraseña"
            title="Copiar contraseña"
          >
            {copied ? (
              <Check className="size-4 text-success" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
        {!decrypting && (
          <p className="text-xs text-muted-foreground">
            El dado genera una contraseña aleatoria de {PASS_LENGTH} caracteres con mayúsculas,
            minúsculas, números y símbolos. Guárdala bien: sin ella el archivo no se podrá abrir.
          </p>
        )}
      </div>

      {!decrypting && (
        <div className="flex flex-col gap-2.5">
          <Label>Perfil de derivación (Argon2id)</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={profile}
            onValueChange={(value) => {
              if (value === 'standard' || value === 'high') setProfile(value)
            }}
            className="justify-start"
          >
            <ToggleGroupItem value="standard">Standard</ToggleGroupItem>
            <ToggleGroupItem value="high">High</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs leading-relaxed text-muted-foreground">
            El perfil controla cuánta memoria y trabajo usa la derivación de la clave (Argon2id),
            que es lo que hace caro atacar tu contraseña por fuerza bruta. <strong>Standard</strong>{' '}
            (~256 MB de memoria): más rápido y suficiente para la mayoría de los archivos.{' '}
            <strong>High</strong> (~1 GB): aún más resistente, pero más lento y pesado — evítalo en
            equipos con poca RAM.
          </p>
        </div>
      )}

      <Button onClick={handleSubmit} disabled={!canSubmit}>
        {decrypting ? 'Desencriptar archivo' : 'Encriptar archivo'}
      </Button>
    </motion.div>
  )
}