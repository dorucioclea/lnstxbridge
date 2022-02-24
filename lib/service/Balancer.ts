import { BalancerConfig } from '../../lib/Config';
import { getAddressAllBalances, getStacksNetwork, sendSTX } from '../../lib/wallet/stacks/StacksUtils';
import Logger from '../Logger';
import Service from './Service';
const { PublicClient } = require("@pseudozach/okex-node");
// const { V3WebsocketClient } = require("@pseudozach/okex-node");
const { AuthenticatedClient } = require("@pseudozach/okex-node");
// const pClient = new PublicClient();
// const wss = new V3WebsocketClient();

class Balancer {
  public pClient = new PublicClient();
  public authClient: any;
  private apiKey: string;
  private tradePassword: string;
  private smallerRate: number;
  private signerAddress: string;

  constructor(private service: Service, private logger: Logger, private balancerConfig: BalancerConfig) {
    this.apiKey = this.balancerConfig.apiKey;
    this.tradePassword = this.balancerConfig.tradePassword;
    this.authClient = new AuthenticatedClient(this.balancerConfig.apiKey, this.balancerConfig.secretKey, this.balancerConfig.passphrase, this.balancerConfig.apiUri);
    this.smallerRate = 0.95;
    this.signerAddress = '';
  }

  public getBalancerConfig = (): {minSTX: number, minBTC: number, overshootPct: number} => {
    return { minSTX: this.balancerConfig.minSTX, minBTC: this.balancerConfig.minBTC, overshootPct: this.balancerConfig.overshootPercentage };
  }

  public getExchangeBalance = async (currency: string): Promise<string> => {
    if (this.apiKey === '') {
      throw new Error('no API key provided');
    }
    // get account + balances
    const accounts = await this.authClient.spot().getAccounts();
    // console.log('accounts ', accounts);
    const currencyAccount = accounts.find((item) => item.currency === currency);
    const currencyBalance = currencyAccount['available'];
    // console.log('balancer.22 getExchangeBalance ', currencyBalance, currency);
    return currencyBalance;
  }

  /**
   * Checks if balancing is needed based on pre-set limits for onchain funds
   */
  public autoBalancer = async (): Promise<void> => {
    const balanceResult = await getAddressAllBalances();
    const signerSTXBalance = balanceResult['STX']/10**6;
    this.logger.verbose(`balancer.52 signerSTXBalance ${signerSTXBalance}`);

    const signerBTCBalance = await this.service.getAdminBalanceOnchain();
    this.logger.verbose(`balancer.55 signerBTCBalance ${signerBTCBalance}`);

    if(signerSTXBalance < this.balancerConfig.minSTX) {
      this.logger.info(`balancer.52 starting auto STX balance ${signerSTXBalance} < ${this.balancerConfig.minSTX}`);
      // const balanceResult = await this.balanceFunds({pairId: 'BTC/STX', buyAmount: this.balancerConfig.minSTX*(1+this.balancerConfig.overshootPercentage)})
      // this.logger.info(`balancer.59 auto STX balanceResult ${balanceResult}`);
    }

    if(Number(signerBTCBalance) < this.balancerConfig.minBTC) {
      this.logger.info(`balancer.58 starting auto BTC balance ${signerBTCBalance} < ${this.balancerConfig.minBTC}`);
      // const balanceResult = await this.balanceFunds({pairId: 'STX/BTC', buyAmount: this.balancerConfig.minBTC*(1+this.balancerConfig.overshootPercentage)})
      // this.logger.info(`balancer.64 auto BTC balanceResult ${balanceResult}`);
    }
  }

  /**
   * Triggers automated balancing via centralized exchange APIs
   * params.pairId: X/Y => sell X, buy Y
   * params.buyAmount: amount of target currency to buy from exchange
   */
  public balanceFunds = async (params: {pairId: string, buyAmount: number}): Promise<{result: string, status: string}> => {
    if (this.apiKey === '') {
      throw new Error('no API key provided');
    }
    if (params.buyAmount === 0) {
      throw new Error('Buy Amount can not be 0');
    }
    this.logger.debug('Balancer.18 balanceFunds start ' + JSON.stringify(params));

    const sellCurrency = params.pairId.split('/')[0];
    const buyCurrency = params.pairId.split('/')[1];
    
    // // get current price
    // const orderbook = await this.pClient.spot().getSpotBook("BTC-USD", {"size":"10"});
    // console.log('orderbook ', orderbook);
    
    const sellRate = (await this.pClient.spot().getSpotTicker(`${sellCurrency}'-USD`))['ask'];
    const buyRate = (await this.pClient.spot().getSpotTicker(`${buyCurrency}'-USD`))['bid'];
    
    // calculate amount to sell to end up with target buy amount
    const smallerBuyAmount = params.buyAmount * this.smallerRate;
    const usdTopup = params.buyAmount * buyRate;
    const smallerUsdTopup = usdTopup * this.smallerRate;
    const sellAmount = usdTopup / sellRate;
    this.logger.verbose(`balancer.101 ${sellRate}, ${buyRate}, ${smallerBuyAmount}, ${usdTopup}, ${smallerUsdTopup}, ${sellAmount}`)
    return {result: "ok", status: "ok"}; 

    if(sellCurrency === 'BTC') {
      // get ln invoice from exchange
      const invoiceResult = await this.authClient.account().getInvoice(sellAmount)
      console.log('invoice ', invoiceResult['invoice']);

      // send payment - deposit to exchange
      // pay ln invoice
      const paymentResult = await this.service.payInvoice('BTC', invoiceResult['invoice']);
      console.log('balancer.110 paymentResult ', paymentResult);

      if(!paymentResult.paymentPreimage) {
        this.logger.error('invoice payment failed');
        // check if succeeded otherwise try depositing onchain btc?
        const addressResult = await this.authClient.account().getAddress('BTC')
        const btcaddress = addressResult.find((item) => item.chain === 'BTC-Bitcoin');
        const btcdepositaddress = btcaddress['address'];
        console.log('btcdepositaddress ', btcdepositaddress);
        const onchainPaymentResult = await this.service.sendCoins({symbol: 'BTC', address: btcdepositaddress, amount: sellAmount})
        console.log('balancer.120 onchainPaymentResult ', onchainPaymentResult);
      }
    } else {
      const addressResult = await this.authClient.account().getAddress('STX')
      const stxaddress = addressResult.find((item) => item.chain === 'STX');
      const stxdepositaddress = stxaddress['address'];
      console.log('stxdepositaddress ', stxdepositaddress);
      const onchainPaymentResult = await sendSTX(stxdepositaddress, sellAmount);
      if(onchainPaymentResult === '') {
        throw new Error('Onchain payment failed');
      }
    }

    const sellResult = await this.authClient.swap().postOrder({"size":sellAmount, "type":"market", "side":"sell", "order_type": "0", "instrument_id":`${sellCurrency}-USD`});
    console.log('balancer.76 sellResult ', sellResult);
    if(!sellResult.result) {
      throw new Error('sell order failed')
    }

    // buy target currency with smaller usd equivalent
    const buyResult = await this.authClient.swap().postOrder({"notional":smallerUsdTopup, "type":"market", "side":"buy", "order_type": "0", "instrument_id":`${buyCurrency}-USD`});
    console.log('postOrder buyResult ', buyResult);
    if(!buyResult.result) {
      throw new Error('buy order failed')
    }

    // transfer funds for withdrawal
    const transferResult = await this.authClient.swap().postTransfer({"currency":buyCurrency, "amount":smallerBuyAmount, "account_from":"1", "account_to": "6"});
    console.log('postTransfer transferResult ', transferResult);
    if(!transferResult.result) {
      throw new Error('transfer failed')
    }

    // find minimum withdrawal fee for buyCurrency
    const feeResult = await this.authClient.account().getWithdrawalFee(buyCurrency);
    console.log('postTransfer feeResult ', feeResult);
    if(!feeResult.result) {
      throw new Error('fee retrieval failed')
    }

    // withdraw to signer wallet
    this.signerAddress = (await getStacksNetwork()).signerAddress;
    const withdrawResult = await this.authClient.swap().postWithdrawal({"currency":buyCurrency, "amount":smallerBuyAmount, "destination":"4", "to_address": this.signerAddress, "trade_pwd": this.tradePassword, "fee": feeResult[0]['min_fee']});
    console.log('postTransfer withdrawResult ', withdrawResult);
    if(!withdrawResult.result) {
      throw new Error('withdrawal failed')
    }
    
    return {
      status: "OK",
      result: `Withdrew ${sellAmount} ${sellCurrency}, Sold from rate ${sellRate}, Bought ${smallerBuyAmount} from rate ${buyRate}, Transferred to ${this.signerAddress}`,
    }
  }
}

export default Balancer;