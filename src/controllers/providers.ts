/* eslint import/namespace: ['error', { allowComputed: true }] */
import * as list from '../providers'
import {
  INJECTED_PROVIDER_ID,
  CACHED_PROVIDER_KEY,
  CACHED_PROVIDER_CHAINS_KEY,
  WALLETS_EVENTS,
  CACHED_MULTI_PROVIDERS_KEY,
  CACHED_PROVIDERS_CHAINS_KEY,
  IChainType
} from '../constants'
import {
  getLocal,
  setLocal,
  getProviderInfoById,
  getProviderDescription,
  filterMatches,
  findMatchingRequiredOptions,
  canInject,
  findAvailableEthereumProvider,
  isCurrentProviderActive,
  IProviderControllerOptions,
  IProviderOption,
  CHAIN_DATA_LIST,
  convertToCommonChain,
  IProviderDisplayWithConnector,
  IProviderOptions,
  IProviderInfo,
  IProviderUserOptions
} from '../helpers'

import { EventController } from './events'
import { disabledDefault } from 'src/providers/injected/utils'

export class ProviderController {
  public cachedProviders: string[] = []
  public shouldCacheProviders = false
  public disableInjectedProvider = false
  public isSingleProviderEnabled: Boolean | undefined

  private eventController: EventController = new EventController()
  public injectedChains: {
    [providerId: string]: string[]
  } = {}

  private providers: IProviderDisplayWithConnector[] = []
  private providerOptions: IProviderOptions
  private network = ''

  constructor(opts: IProviderControllerOptions) {
    this.disableInjectedProvider = opts.disableInjectedProvider
    this.shouldCacheProviders = opts.cacheProviders
    this.providerOptions = opts.providerOptions
    this.network = opts.network
    this.isSingleProviderEnabled = opts.isSingleProviderEnabled
  }

  public getInjectedById = (providerId: string) => {
    return list.injected[providerId.toUpperCase()]
  }

  public init() {
    this.updateCachedProviders(getLocal(this.cachedProvidersKey) || [])
    this.injectedChains = getLocal(this.cachedProviderChainsKey) || {}
    this.providers = []
    // parse custom providers
    Object.keys(this.providerOptions).map((id) => {
      if (id && this.providerOptions[id]) {
        const options = this.providerOptions[id]
        const displayProps = this.getInjectedById(id)
        if (typeof displayProps !== 'undefined') {
          this.providers.push({
            ...list.providers.INJECTED,
            connector: options.connector || list.connectors.injected,
            ...displayProps,
            ...options.display,
            id
          })
        }
      }
    })
    this.providers.push(
      ...Object.keys(list.connectors)
        .filter((id: string) => !!this.providerOptions[id])
        .map((id: string) => {
          let providerInfo: IProviderInfo
          if (id === INJECTED_PROVIDER_ID) {
            providerInfo =
              this.getProviderOption(id)?.display || list.providers.INJECTED
          } else {
            providerInfo = getProviderInfoById(id)
          }
          // parse custom display options
          if (this.providerOptions[id]) {
            providerInfo = {
              ...providerInfo,
              ...this.providerOptions[id].display
            }
          }
          return {
            ...providerInfo,
            connector: list.connectors[id],
            package: providerInfo.package
          }
        })
    )
  }

  public shouldDisplayProvider(id: string) {
    const provider = this.getProvider(id)
    if (typeof provider !== 'undefined') {
      const providerPackageOptions = this.providerOptions[id]
      if (providerPackageOptions) {
        const requiredOptions = provider.package
          ? provider.package.required
          : undefined

        if (requiredOptions && requiredOptions.length) {
          const providedOptions = providerPackageOptions.options
          if (providedOptions && Object.keys(providedOptions).length) {
            const matches = findMatchingRequiredOptions(
              requiredOptions,
              providedOptions
            )
            if (requiredOptions.length === matches.length) {
              return true
            }
          }
        } else {
          return true
        }
      }
    }
    return false
  }

  public getUserOptions = () => {
    const defaultProviderList = Array.from(
      new Set(this.providers.map(({ id }) => id))
    )

    const availableInjectedList = defaultProviderList.filter(
      (pid) => this.getInjectedById(pid) && this.isAvailableProvider(pid)
    )

    const injectedList = defaultProviderList.filter((pid) => {
      const target = this.getInjectedById(pid)
      return target && pid !== 'xdefi'
    })

    const browserInjectedList = availableInjectedList.filter(
      (provider) => provider !== 'xdefi'
    )

    const displayInjected =
      !this.disableInjectedProvider &&
      browserInjectedList.length === 0 &&
      canInject()

    const providerList: string[] = []

    defaultProviderList.forEach((id: string) => {
      if (id !== INJECTED_PROVIDER_ID) {
        const result = this.shouldDisplayProvider(id)
        if (result) {
          providerList.push(id)
        }
      } else if (displayInjected) {
        providerList.push(INJECTED_PROVIDER_ID)
      }
    })

    const userOptions: IProviderUserOptions[] = []

    providerList.forEach((id: string) => {
      const provider = this.getProvider(id)
      if (typeof provider !== 'undefined') {
        const { id, name, logo, connector, ...rest } = provider

        userOptions.push({
          id,
          name,
          logo,
          description: getProviderDescription(provider),
          onClick: (chains: string[] = []) =>
            this.connectTo(id, connector, chains),
          ...rest
        })
      }
    })

    const providersWithoutInjected = userOptions.filter(
      (provider) => !injectedList.find((id) => id === provider.id)
    )

    if (browserInjectedList.length) {
      const wallet = userOptions.find(
        (option) => option.id === browserInjectedList[0]
      )

      if (wallet) {
        return [
          providersWithoutInjected[0],
          { ...wallet, label: 'Browser Wallet' },
          ...providersWithoutInjected.slice(1)
        ]
      }
    }

    return providersWithoutInjected
  }

  public connectToChains = async (
    providerId: string,
    chains: string[] = []
  ) => {
    const options = this.findProviderFromOptions(providerId)
    const providerOption = this.getProviderOption(providerId)
    const providerPackage = providerOption?.package
    const opts = {
      network: this.network || undefined,
      ...providerOption.options
    }

    const providerTemplate = options?.getEthereumProvider
      ? options?.getEthereumProvider()
      : undefined

    const results: { chain: IChainType; accounts: string[] }[] = []

    const currentProviderChains = options?.chains

    let hasError = false
    if (currentProviderChains) {
      const targetList = (
        this.injectedChains &&
        this.injectedChains[providerId] &&
        this.injectedChains[providerId].length > 0
          ? this.injectedChains[providerId]
          : chains
      ).filter((chain) => !!currentProviderChains[chain])

      for (let i = 0; i < targetList.length; i++) {
        const chain = targetList[i]
        const target = currentProviderChains[chain]
        if (target) {
          try {
            const accounts = await target.methods.getAccounts(
              options?.getEthereumProvider
                ? options.getEthereumProvider()
                : undefined
            )
            results.push({
              chain: chain as IChainType,
              accounts: accounts
            })
          } catch (e) {
            hasError = true
            console.error(e)

            if (e?.code === 4001) {
              throw new Error(e.code)
            }
          }
        }
      }
    }

    const hasCustomAccountsLoading = results.length > 0 && providerTemplate

    const provider = hasCustomAccountsLoading
      ? providerTemplate
      : await options?.connector(
          providerPackage,
          opts,
          chains,
          options?.getEthereumProvider
        )

    if (!hasCustomAccountsLoading && !hasError) {
      let ethAccounts: string[] = []

      let chain = IChainType.ethereum
      try {
        const chainId = await provider.request({
          method: 'eth_chainId'
        })

        const chainUnformatted = CHAIN_DATA_LIST[Number(chainId)].network
        chain = convertToCommonChain(chainUnformatted)

        ethAccounts = await provider.request({
          method: 'eth_requestAccounts'
        })
      } catch (e) {
        ethAccounts = Array.isArray(provider.accounts) ? provider.accounts : []
      }

      results.push({
        chain: chain,
        accounts: ethAccounts
      })
    }

    // const rejected = results
    //   .filter((result) => result.status === 'rejected')
    //   .map((result) => result.reason)
    // if (rejected.length > 0) {
    //   throw new Error(rejected[0])
    // }

    return {
      connectedList: results,
      provider
    }
  }

  public getProvider(id: string) {
    return filterMatches<IProviderDisplayWithConnector>(
      this.providers,
      (x) => x.id === id,
      undefined
    )
  }

  public getProviderOption(id: string): IProviderOption {
    return this.providerOptions && this.providerOptions[id]
      ? this.providerOptions[id]
      : ({} as IProviderOption)
  }

  public clearCachedProvider(providerId?: string) {
    if (this.cachedProviders) {
      const listClear = providerId
        ? this.cachedProviders.filter((x) => x === providerId)
        : this.cachedProviders

      listClear.forEach((p) => {
        delete this.injectedChains[p]
      })

      const available = Object.keys(this.injectedChains)

      this.updateCachedProviders(available)

      setLocal(this.cachedProviderChainsKey, this.injectedChains)

      listClear.forEach((pid) => {
        this.trigger(WALLETS_EVENTS.CLOSE, pid)
      })
    }

    return false
  }

  private updateCachedProviders(providers: string[]) {
    this.cachedProviders = (
      this.isSingleProviderEnabled && providers.length > 0
        ? providers.slice(0, 1)
        : providers
    ).filter(this.isAvailableProvider)
    setLocal(this.cachedProvidersKey, this.cachedProviders)

    this.trigger(WALLETS_EVENTS.UPDATED_PROVIDERS_LIST, this.cachedProviders)
  }

  public setCachedProvider(id: string, chains: string[]) {
    const unique = new Set([...this.cachedProviders, id])
    this.updateCachedProviders(Array.from(unique))

    this.setInjectedChains(id, chains)
  }

  get cachedProvidersKey() {
    return this.isSingleProviderEnabled
      ? CACHED_PROVIDER_KEY
      : CACHED_MULTI_PROVIDERS_KEY
  }

  get cachedProviderChainsKey() {
    return this.isSingleProviderEnabled
      ? CACHED_PROVIDER_CHAINS_KEY
      : CACHED_PROVIDERS_CHAINS_KEY
  }

  public setInjectedChains(providerId: string, chains: string[]) {
    this.injectedChains[providerId] = chains
    setLocal(this.cachedProviderChainsKey, this.injectedChains)
  }

  public findProviderFromOptions(providerId: string) {
    return this.providers.find(({ id }) => id === providerId)
  }

  public getEthereumProvider = (providerId: string) => {
    const options =
      this.findProviderFromOptions(providerId) ||
      list.providers[providerId.toUpperCase()]

    return options && options?.getEthereumProvider
      ? options?.getEthereumProvider()
      : findAvailableEthereumProvider()
  }

  public connectTo = async (
    id: string,
    connector: (
      providerPackage: any,
      opts: any,
      chains?: string[],
      getProvider?: () => any
    ) => Promise<any>,
    chains: string[]
  ) => {
    try {
      this.trigger(WALLETS_EVENTS.SELECT, id)

      const { provider } = await this.connectToChains(id, chains)

      this.trigger(WALLETS_EVENTS.CONNECT, {
        provider,
        id
      })

      if (this.shouldCacheProviders) {
        this.setCachedProvider(id, chains)
      }
    } catch (error) {
      this.trigger(WALLETS_EVENTS.ERROR, error)
    }
  }

  public async connectToCachedProviders() {
    return Promise.allSettled(
      (this.cachedProviders || [])
        .filter(this.isAvailableProvider)
        .map((pid: string) => {
          const provider = this.getProvider(pid)
          if (provider) {
            return this.connectTo(
              provider.id,
              provider.connector,
              this.injectedChains[provider.id]
            )
          }
          return null
        })
    )
  }

  public isAvailableProvider = (providerId: string) => {
    const injected = this.getInjectedById(providerId)

    if (!injected) {
      return true // Provider is not defined at list of injected and we do not controll this provider
    }

    if (this.disabledByProvider(providerId)) {
      return false
    }
    const provider = this.getEthereumProvider(providerId)
    const isActive = isCurrentProviderActive(provider, injected)

    return isActive
  }

  public disabledByProvider = (providerId: string) => {
    if (!this.getInjectedById(providerId)) {
      return undefined // Provider is not defined at list of injected and we do not controll this provider
    }

    const options = this.findProviderFromOptions(providerId)

    const defaultDisabledByProvider = disabledDefault(providerId)
    if (defaultDisabledByProvider) {
      return defaultDisabledByProvider
    }

    if (
      options &&
      options.disabledByWalletFunc &&
      options.disabledByWalletFunc()
    ) {
      return options.disabledByWalletFunc()
    }

    return undefined
  }

  public on(event: string, callback: (result: any) => void): () => void {
    this.eventController.on({
      event,
      callback
    })

    return () =>
      this.eventController.off({
        event,
        callback
      })
  }

  public off(event: string, callback?: (result: any) => void): void {
    this.eventController.off({
      event,
      callback
    })
  }

  public trigger(event: string, data: any = undefined): void {
    this.eventController.trigger(event, data)
  }
}
