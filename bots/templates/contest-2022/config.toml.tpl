# Сгенерировано Botyard. Правка в Dokploy будет перезаписана следующим развёртыванием.

[log]
level = "{{ config.logLevel }}"

[metrics]
enabled = true
addr = ":2112"

[account]
number = "{{ customer.accountId }}"
sandbox = {{ customer.sandbox }}

[clients]
[clients.tinkfoff_invest]
address = "{{ platform.tinvestAddress }}"
app_name = "botyard"
token = "{{ secret.tinvestToken }}"

[strategies]
[strategies.bulls_and_bears_monitoring]
enabled = true
ignore_inconsistent = false
{{#each config.instruments}}
[[strategies.bulls_and_bears_monitoring.instruments]]
figi = "{{ figi }}"
depth = {{ depth }}
dominance_ratio = {{ dominanceRatio }}
profit_percentage = {{ profitPercentage }}
{{/each}}

[strategies.spread_parasite]
enabled = false
