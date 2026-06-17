#![no_std]
#![allow(deprecated)]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

#[contract]
pub struct RwaMarketplace;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    PaymentToken,
    PricePerShare,
    TotalShares,
    AvailableShares,
    Paused,
    Balance(Address),
}

#[derive(Clone)]
#[contracttype]
pub enum Event {
    Init(Address, Address, i128, u32),
    BuyShares(Address, u32, i128),
    Pause,
    Unpause,
    EmergencyWithdraw(Address, i128),
}

#[contractimpl]
impl RwaMarketplace {
    pub fn init(env: Env, admin: Address, payment_token: Address, price: i128, total_shares: u32) {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Marketplace is already initialized");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PaymentToken, &payment_token);
        env.storage().instance().set(&DataKey::PricePerShare, &price);
        env.storage().instance().set(&DataKey::TotalShares, &total_shares);
        env.storage().instance().set(&DataKey::AvailableShares, &total_shares);
        env.storage().instance().set(&DataKey::Paused, &false);

        env.events().publish(
            (Symbol::new(&env, "init"),),
            (admin, payment_token, price, total_shares),
        );
    }

    pub fn buy_shares(env: Env, buyer: Address, shares: u32) {
        buyer.require_auth();

        if env.storage().instance().get(&DataKey::Paused).unwrap_or(false) {
            panic!("Marketplace is paused");
        }

        let available: u32 = env
            .storage()
            .instance()
            .get(&DataKey::AvailableShares)
            .unwrap();

        if shares > available {
            panic!("Not enough shares available for purchase");
        }

        if shares == 0 {
            panic!("Must purchase at least 1 share");
        }

        let price: i128 = env.storage().instance().get(&DataKey::PricePerShare).unwrap();
        let total_cost = price * (shares as i128);

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        let token_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::PaymentToken)
            .unwrap();

        let client = token::Client::new(&env, &token_id);
        client.transfer(&buyer, &admin, &total_cost);

        env.storage()
            .instance()
            .set(&DataKey::AvailableShares, &(available - shares));

        let mut buyer_balance: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(buyer.clone()))
            .unwrap_or(0);
        buyer_balance += shares;
        env.storage()
            .persistent()
            .set(&DataKey::Balance(buyer.clone()), &buyer_balance);

        env.events().publish(
            (Symbol::new(&env, "buy_shares"),),
            (buyer, shares, total_cost),
        );
    }

    pub fn get_shares(env: Env, owner: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(owner))
            .unwrap_or(0)
    }

    pub fn get_available_shares(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::AvailableShares)
            .unwrap_or(0)
    }

    pub fn get_total_shares(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0)
    }

    pub fn get_price(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::PricePerShare)
            .unwrap_or(0)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(true)
    }

    pub fn pause(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((Symbol::new(&env, "pause"),), ());
    }

    pub fn unpause(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((Symbol::new(&env, "unpause"),), ());
    }

    pub fn emergency_withdraw(env: Env, to: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let token_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::PaymentToken)
            .unwrap();

        let client = token::Client::new(&env, &token_id);
        client.transfer(&env.current_contract_address(), &to, &amount);

        env.events().publish(
            (Symbol::new(&env, "emergency_withdraw"),),
            (to, amount),
        );
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, token, Env};

    struct TestEnv {
        env: Env,
        admin: Address,
        buyer: Address,
        token_id: Address,
        contract_id: Address,
    }

    fn setup() -> TestEnv {
        let env = Env::default();
        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = sac.address();
        let contract_id = env.register(RwaMarketplace, ());
        env.mock_all_auths();
        TestEnv { env, admin, buyer, token_id, contract_id }
    }

    fn client(te: &TestEnv) -> RwaMarketplaceClient<'_> {
        RwaMarketplaceClient::new(&te.env, &te.contract_id)
    }

    fn mint(te: &TestEnv, to: &Address, amount: i128) {
        token::StellarAssetClient::new(&te.env, &te.token_id).mint(to, &amount);
    }

    #[test]
    fn test_init_and_query() {
        let te = setup();
        let c = client(&te);
        c.init(&te.admin, &te.token_id, &100, &1000);

        assert_eq!(c.get_total_shares(), 1000);
        assert_eq!(c.get_available_shares(), 1000);
        assert_eq!(c.get_price(), 100);
        assert!(!c.is_paused());
        assert_eq!(c.get_shares(&te.admin), 0);
    }

    #[test]
    fn test_buy_shares() {
        let te = setup();
        let c = client(&te);
        c.init(&te.admin, &te.token_id, &100, &1000);
        mint(&te, &te.buyer, 100000);

        c.buy_shares(&te.buyer, &25);
        assert_eq!(c.get_shares(&te.buyer), 25);
        assert_eq!(c.get_available_shares(), 975);
    }

    #[test]
    fn test_multiple_buys() {
        let te = setup();
        let c = client(&te);
        c.init(&te.admin, &te.token_id, &100, &1000);
        mint(&te, &te.buyer, 100000);

        c.buy_shares(&te.buyer, &10);
        c.buy_shares(&te.buyer, &20);
        assert_eq!(c.get_shares(&te.buyer), 30);
        assert_eq!(c.get_available_shares(), 970);
    }

    #[test]
    fn test_pause_unpause() {
        let te = setup();
        let c = client(&te);
        c.init(&te.admin, &te.token_id, &100, &1000);

        assert!(!c.is_paused());
        c.pause();
        assert!(c.is_paused());
        c.unpause();
        assert!(!c.is_paused());
    }

    #[test]
    #[should_panic(expected = "Marketplace is paused")]
    fn test_buy_when_paused() {
        let te = setup();
        let c = client(&te);
        c.init(&te.admin, &te.token_id, &100, &1000);
        c.pause();
        c.buy_shares(&te.buyer, &1);
    }

    #[test]
    #[should_panic(expected = "Marketplace is already initialized")]
    fn test_double_init() {
        let te = setup();
        let c = client(&te);
        c.init(&te.admin, &te.token_id, &100, &1000);
        c.init(&te.admin, &te.token_id, &100, &1000);
    }

    #[test]
    #[should_panic(expected = "Not enough shares available")]
    fn test_overbuy() {
        let te = setup();
        let c = client(&te);
        c.init(&te.admin, &te.token_id, &100, &10);
        mint(&te, &te.buyer, 100000);
        c.buy_shares(&te.buyer, &20);
    }

    #[test]
    #[should_panic(expected = "Must purchase at least 1 share")]
    fn test_zero_shares() {
        let te = setup();
        let c = client(&te);
        c.init(&te.admin, &te.token_id, &100, &1000);
        c.buy_shares(&te.buyer, &0);
    }

    #[test]
    fn test_emergency_withdraw() {
        let te = setup();
        let c = client(&te);
        c.init(&te.admin, &te.token_id, &100, &1000);
        c.emergency_withdraw(&te.admin, &0);
    }
}
